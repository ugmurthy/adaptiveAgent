use rusqlite::{params, Connection, TransactionBehavior};
use std::{path::Path, sync::Mutex};

const MIGRATIONS: &[(i64, &str)] = &[(
    1,
    r#"
create table workbench_items (id text primary key, kind text not null check(kind in ('task','chat')), title text not null, session_id text unique, pinned_agent_id text not null, pinned_agent_name text not null, pinned_agent_fingerprint text not null, created_at text not null, updated_at text not null, deletion_state text);
create table workbench_runs (run_id text primary key, item_id text not null references workbench_items(id) on delete cascade, turn_index integer, invocation_kind text not null check(invocation_kind in ('run','chat')), cached_status text not null, submission_state text not null, created_at text not null, updated_at text not null);
create table chat_messages (id text primary key, item_id text not null references workbench_items(id) on delete cascade, ordinal integer not null, role text not null check(role in ('user','assistant')), content_json text not null, run_id text references workbench_runs(run_id), created_at text not null, unique(item_id, ordinal));
create table desktop_settings (key text primary key, value_json text not null);
create table deletion_jobs (id text primary key, item_id text, root_run_id text, state text not null, last_error text, created_at text not null, updated_at text not null);
"#,
)];

#[derive(Clone, Debug, PartialEq)]
pub struct Reservation {
    pub item_id: String,
    pub run_id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_fingerprint: String,
    pub invocation_kind: String,
    pub cached_status: String,
    pub submission_state: String,
}

pub struct WorkbenchDb {
    connection: Mutex<Connection>,
}

impl WorkbenchDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        let db = Self {
            connection: Mutex::new(connection),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        connection.execute_batch("create table if not exists desktop_migrations(version integer primary key, applied_at text not null);").map_err(|e| e.to_string())?;
        for (version, sql) in MIGRATIONS {
            let installed: bool = connection
                .query_row(
                    "select exists(select 1 from desktop_migrations where version=?1)",
                    [version],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !installed {
                let tx = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|e| e.to_string())?;
                tx.execute_batch(sql).map_err(|e| e.to_string())?;
                tx.execute(
                    "insert into desktop_migrations values(?1, datetime('now'))",
                    [version],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn reserve_task(&self, reservation: &Reservation) -> Result<(), String> {
        let now = now();
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute("insert into workbench_items(id,kind,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,created_at,updated_at) values(?1,'task',?2,?3,?4,?5,?6,?7,?7)", params![reservation.item_id,reservation.title,reservation.session_id,reservation.agent_id,reservation.agent_name,reservation.agent_fingerprint,now]).map_err(|e| e.to_string())?;
        tx.execute("insert into workbench_runs(run_id,item_id,invocation_kind,cached_status,submission_state,created_at,updated_at) values(?1,?2,?3,?4,?5,?6,?6)", params![reservation.run_id,reservation.item_id,reservation.invocation_kind,reservation.cached_status,reservation.submission_state,now]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn update_run(
        &self,
        run_id: &str,
        cached_status: &str,
        submission_state: &str,
    ) -> Result<(), String> {
        self.connection.lock().unwrap().execute("update workbench_runs set cached_status=?2,submission_state=?3,updated_at=?4 where run_id=?1", params![run_id,cached_status,submission_state,now()]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_runs(&self) -> Result<Vec<Reservation>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select i.id,r.run_id,i.title,i.session_id,i.pinned_agent_id,i.pinned_agent_name,i.pinned_agent_fingerprint,r.invocation_kind,r.cached_status,r.submission_state from workbench_runs r join workbench_items i on i.id=r.item_id order by r.created_at,r.run_id").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok(Reservation {
                    item_id: r.get(0)?,
                    run_id: r.get(1)?,
                    title: r.get(2)?,
                    session_id: r.get(3)?,
                    agent_id: r.get(4)?,
                    agent_name: r.get(5)?,
                    agent_fingerprint: r.get(6)?,
                    invocation_kind: r.get(7)?,
                    cached_status: r.get(8)?,
                    submission_state: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

fn now() -> String {
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;
    fn reservation() -> Reservation {
        Reservation {
            item_id: "item".into(),
            run_id: "run".into(),
            title: "Task".into(),
            session_id: None,
            agent_id: "agent".into(),
            agent_name: "Agent".into(),
            agent_fingerprint: "fp".into(),
            invocation_kind: "run".into(),
            cached_status: "reserved".into(),
            submission_state: "reserved".into(),
        }
    }
    #[test]
    fn migrations_are_idempotent_and_reservations_rehydrate() {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let db = WorkbenchDb::open(file.path()).unwrap();
            db.reserve_task(&reservation()).unwrap();
            assert_eq!(db.load_runs().unwrap(), vec![reservation()]);
        }
        assert_eq!(
            WorkbenchDb::open(file.path())
                .unwrap()
                .load_runs()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn foreign_keys_are_enabled() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let db = WorkbenchDb::open(file.path()).unwrap();
        let error = db
            .connection
            .lock()
            .unwrap()
            .execute(
                "insert into workbench_runs values('r','missing',null,'run','x','x','x','x')",
                [],
            )
            .unwrap_err();
        assert!(error.to_string().contains("FOREIGN KEY"));
    }
    #[test]
    fn reservation_is_atomic() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let db = WorkbenchDb::open(file.path()).unwrap();
        let mut invalid = reservation();
        invalid.invocation_kind = "bad".into();
        assert!(db.reserve_task(&invalid).is_err());
        let count: Option<String> = db
            .connection
            .lock()
            .unwrap()
            .query_row("select id from workbench_items where id='item'", [], |r| {
                r.get(0)
            })
            .optional()
            .unwrap();
        assert!(count.is_none());
    }
}
