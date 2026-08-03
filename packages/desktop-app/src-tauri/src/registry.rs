use crate::workbench::PendingApproval;
use std::collections::HashMap;

pub const CAPACITY: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelAction {
    AwaitCreation,
    Interrupt,
    AlreadyRequested,
    Quiescent,
}

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
    pub interrupt_pending: bool,
    pub request_active: bool,
    pub revision: u64,
    pub pending_interaction: Option<String>,
    pub pending_approval: Option<PendingApproval>,
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
    pub fn remove(&mut self, id: &str) {
        self.records.remove(id);
    }
    pub fn get(&self, id: &str) -> Option<&RunRecord> {
        self.records.get(id)
    }
    pub fn get_mut(&mut self, id: &str) -> Option<&mut RunRecord> {
        self.records.get_mut(id)
    }
    pub fn occupied_slot_count(&self) -> usize {
        self.records.values().filter(|r| r.occupies_slot).count()
    }
    pub fn has_capacity(&self) -> bool {
        self.occupied_slot_count() < CAPACITY
    }
    pub fn item_is_occupied(&self, item_id: &str) -> bool {
        self.records
            .values()
            .any(|record| record.item_id == item_id && record.occupies_slot)
    }
    pub fn records(&self) -> impl Iterator<Item = &RunRecord> {
        self.records.values()
    }
    pub fn any_active(&self) -> bool {
        self.records.values().any(|r| r.occupies_slot)
    }
    pub fn any_stopping(&self) -> bool {
        self.records
            .values()
            .any(|r| r.occupies_slot && r.cancel_requested)
    }
    pub fn occupied_ids(&self) -> Vec<String> {
        self.records
            .values()
            .filter(|record| record.occupies_slot)
            .map(|record| record.run_id.clone())
            .collect()
    }
    #[cfg(test)]
    pub fn cancellation_selection(&mut self) -> Vec<(String, CancelAction)> {
        let ids = self.occupied_ids();
        ids.into_iter()
            .map(|id| {
                let action = self.request_cancel(&id).expect("selected run must exist");
                (id, action)
            })
            .collect()
    }
    pub fn request_cancel(&mut self, id: &str) -> Result<CancelAction, &'static str> {
        let record = self.records.get_mut(id).ok_or("Run is not known.")?;
        if !record.occupies_slot {
            return Ok(CancelAction::Quiescent);
        }
        let already_requested = record.cancel_requested;
        record.cancel_requested = true;
        record.revision += 1;
        Ok(if record.root_created {
            record.interrupt_pending = true;
            CancelAction::Interrupt
        } else if already_requested {
            CancelAction::AlreadyRequested
        } else {
            CancelAction::AwaitCreation
        })
    }
    pub fn ids_requiring_reconciliation(&self) -> Vec<String> {
        self.records
            .values()
            .filter(|record| {
                !matches!(
                    record.submission_state.as_str(),
                    "terminal" | "submission_failed"
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
pub(crate) fn tests_record_for_transition() -> RunRecord {
    RunRecord {
        run_id: "transition".into(),
        item_id: "item-transition".into(),
        session_id: None,
        invocation_kind: "run".into(),
        submission_state: "submitted".into(),
        cached_status: "submitted".into(),
        root_created: false,
        cancel_requested: false,
        interrupt_pending: false,
        request_active: false,
        revision: 0,
        pending_interaction: None,
        pending_approval: None,
        occupies_slot: true,
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
            interrupt_pending: false,
            request_active: false,
            revision: 0,
            pending_interaction: None,
            pending_approval: None,
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
        assert_eq!(r.request_cancel("a"), Ok(CancelAction::AwaitCreation));
        assert!(!r.get("a").unwrap().root_created && r.get("a").unwrap().cancel_requested)
    }

    #[test]
    fn cancellation_is_run_addressed_and_idempotent() {
        let mut registry = RunRegistry::default();
        registry.insert(rec("a"));
        registry.insert(rec("b"));
        registry.get_mut("b").unwrap().root_created = true;

        assert_eq!(registry.request_cancel("b"), Ok(CancelAction::Interrupt));
        assert_eq!(registry.request_cancel("b"), Ok(CancelAction::Interrupt));
        assert!(!registry.get("a").unwrap().cancel_requested);
        assert_eq!(registry.request_cancel("missing"), Err("Run is not known."));

        registry.terminal("a", "succeeded");
        assert_eq!(registry.request_cancel("a"), Ok(CancelAction::Quiescent));
    }

    #[test]
    fn terminate_selects_every_occupied_root_including_not_yet_created() {
        let mut registry = RunRegistry::default();
        registry.insert(rec("late"));
        registry.insert(rec("known"));
        registry.get_mut("known").unwrap().root_created = true;
        registry.insert(rec("done"));
        registry.terminal("done", "succeeded");
        let selected = registry.cancellation_selection();
        assert!(selected.contains(&("late".into(), CancelAction::AwaitCreation)));
        assert!(selected.contains(&("known".into(), CancelAction::Interrupt)));
        assert!(!selected.iter().any(|(id, _)| id == "done"));
        assert!(registry.get("late").unwrap().cancel_requested);
    }

    #[test]
    fn concurrent_coordinator_registry_reservation_allows_exactly_three_winners() {
        let registry = Arc::new(Mutex::new(RunRegistry::default()));
        let submission = Arc::new(Mutex::new(()));
        let barrier = Arc::new(Barrier::new(5));
        let mut workers = Vec::new();

        for id in ["a", "b", "c", "d"] {
            let registry = registry.clone();
            let submission = submission.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                let _submission = submission.lock().unwrap();
                let mut registry = registry.lock().unwrap();
                if !registry.has_capacity() {
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
        assert_eq!(winners, 3);
    }
}
