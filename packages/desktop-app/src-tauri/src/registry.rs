use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct RunRecord {
    pub run_id: String,
    pub item_id: String,
    pub session_id: Option<String>,
    pub invocation_kind: String,
    pub submission_state: String,
    pub cached_status: String,
    pub root_created: bool,
    pub cancel_requested: bool,
    pub pending_interaction: Option<String>,
    pub occupies_slot: bool,
}

#[derive(Default)]
pub struct RunRegistry {
    records: HashMap<String, RunRecord>,
}
impl RunRegistry {
    pub fn insert(&mut self, record: RunRecord) {
        self.records.insert(record.run_id.clone(), record);
    }
    pub fn get(&self, id: &str) -> Option<&RunRecord> {
        self.records.get(id)
    }
    pub fn get_mut(&mut self, id: &str) -> Option<&mut RunRecord> {
        self.records.get_mut(id)
    }
    pub fn active_id(&self) -> Option<String> {
        self.records
            .values()
            .find(|r| r.occupies_slot)
            .map(|r| r.run_id.clone())
    }
    pub fn any_active(&self) -> bool {
        self.records.values().any(|r| r.occupies_slot)
    }
    pub fn any_stopping(&self) -> bool {
        self.records
            .values()
            .any(|r| r.occupies_slot && r.cancel_requested)
    }
    pub fn ids_requiring_reconciliation(&self) -> Vec<String> {
        self.records
            .values()
            .filter(|record| {
                !matches!(
                    record.submission_state.as_str(),
                    "terminal" | "submission_failed" | "recovery_required"
                )
            })
            .map(|record| record.run_id.clone())
            .collect()
    }
    pub fn terminal(&mut self, id: &str, status: &str) -> bool {
        let Some(r) = self.records.get_mut(id) else {
            return false;
        };
        if !r.occupies_slot {
            return false;
        };
        r.occupies_slot = false;
        r.cached_status = status.into();
        r.submission_state = "terminal".into();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};
    fn rec(id: &str) -> RunRecord {
        RunRecord {
            run_id: id.into(),
            item_id: format!("i-{id}"),
            session_id: None,
            invocation_kind: "run".into(),
            submission_state: "submitted".into(),
            cached_status: "running".into(),
            root_created: false,
            cancel_requested: false,
            pending_interaction: None,
            occupies_slot: true,
        }
    }
    #[test]
    fn interleaved_and_duplicate_terminal_are_correlated() {
        let mut r = RunRegistry::default();
        r.insert(rec("a"));
        r.insert(rec("b"));
        r.get_mut("b").unwrap().root_created = true;
        assert!(!r.get("a").unwrap().root_created);
        assert!(r.terminal("a", "completed"));
        assert!(!r.terminal("a", "failed"));
        assert!(r.get("b").unwrap().occupies_slot)
    }
    #[test]
    fn stop_before_create_is_retained() {
        let mut r = RunRegistry::default();
        r.insert(rec("a"));
        r.get_mut("a").unwrap().cancel_requested = true;
        assert!(!r.get("a").unwrap().root_created && r.get("a").unwrap().cancel_requested)
    }

    #[test]
    fn concurrent_coordinator_registry_reservation_allows_only_one_winner() {
        let registry = Arc::new(Mutex::new(RunRegistry::default()));
        let submission = Arc::new(Mutex::new(()));
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();

        for id in ["a", "b"] {
            let registry = registry.clone();
            let submission = submission.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                let _submission = submission.lock().unwrap();
                let mut registry = registry.lock().unwrap();
                if registry.any_active() {
                    return false;
                }
                registry.insert(rec(id));
                true
            }));
        }

        barrier.wait();
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
    }
}
