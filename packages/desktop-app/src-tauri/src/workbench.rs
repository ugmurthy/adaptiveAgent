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
), (
    2,
    "alter table workbench_runs add column cancel_requested integer not null default 0; alter table workbench_runs add column result_json text;",
) ,(
    3,
    "alter table workbench_runs add column interrupt_pending integer not null default 0;",
) ,(
    4,
    "create unique index chat_messages_assistant_run on chat_messages(run_id) where role='assistant' and run_id is not null;",
), (
    5,
    "create table pending_approvals (root_run_id text primary key references workbench_runs(run_id) on delete cascade, approval_run_id text not null, approval_id text not null, parent_run_id text, tool_name text not null, message text not null, decision_in_flight integer not null default 0, decision integer, operation_state text not null default 'awaiting_decision' check(operation_state in ('awaiting_decision','resolving','resume_pending','rejection_pending')), updated_at text not null);",
)];

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub root_run_id: String,
    pub approval_run_id: String,
    pub approval_id: String,
    pub parent_run_id: Option<String>,
    pub tool_name: String,
    pub message: String,
    pub decision_in_flight: bool,
    #[serde(skip)]
    pub decision: Option<bool>,
    #[serde(skip)]
    pub operation_state: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub item_id: String,
    pub title: String,
    pub session_id: String,
    pub pinned_agent_id: String,
    pub pinned_agent_name: String,
    pub pinned_agent_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub ordinal: i64,
    pub role: String,
    pub content: String,
    pub run_id: Option<String>,
}

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
    pub cancel_requested: bool,
    pub interrupt_pending: bool,
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

    pub fn create_chat(&self, chat: &ChatItem) -> Result<(), String> {
        let now = now();
        self.connection.lock().unwrap().execute("insert into workbench_items(id,kind,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,created_at,updated_at) values(?1,'chat',?2,?3,?4,?5,?6,?7,?7)", params![chat.item_id,chat.title,chat.session_id,chat.pinned_agent_id,chat.pinned_agent_name,chat.pinned_agent_fingerprint,now]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_chats(&self) -> Result<Vec<ChatItem>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select id,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint from workbench_items where kind='chat' order by updated_at desc,id").map_err(|e| e.to_string())?;
        let chats = statement
            .query_map([], |r| {
                Ok(ChatItem {
                    item_id: r.get(0)?,
                    title: r.get(1)?,
                    session_id: r.get(2)?,
                    pinned_agent_id: r.get(3)?,
                    pinned_agent_name: r.get(4)?,
                    pinned_agent_fingerprint: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(chats)
    }

    pub fn load_chat(&self, item_id: &str) -> Result<(ChatItem, Vec<ChatMessage>), String> {
        use rusqlite::OptionalExtension;
        let connection = self.connection.lock().unwrap();
        let chat = connection.query_row("select id,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint from workbench_items where id=?1 and kind='chat'", [item_id], |r| Ok(ChatItem { item_id:r.get(0)?, title:r.get(1)?, session_id:r.get(2)?, pinned_agent_id:r.get(3)?, pinned_agent_name:r.get(4)?, pinned_agent_fingerprint:r.get(5)? })).optional().map_err(|e| e.to_string())?.ok_or("Chat was not found.")?;
        let mut statement = connection.prepare("select id,ordinal,role,content_json,run_id from chat_messages where item_id=?1 order by ordinal").map_err(|e| e.to_string())?;
        let messages = statement
            .query_map([item_id], |r| {
                let encoded: String = r.get(3)?;
                let content = serde_json::from_str::<String>(&encoded).unwrap_or(encoded);
                Ok(ChatMessage {
                    id: r.get(0)?,
                    ordinal: r.get(1)?,
                    role: r.get(2)?,
                    content,
                    run_id: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok((chat, messages))
    }

    pub fn reserve_chat_turn(
        &self,
        item_id: &str,
        run_id: &str,
        content: &str,
    ) -> Result<Vec<ChatMessage>, String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let occupied:i64=tx.query_row("select count(*) from workbench_runs where item_id=?1 and submission_state not in ('terminal','submission_failed')",[item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if occupied > 0 {
            return Err("This chat already has a turn in progress.".into());
        }
        let ordinal: i64 = tx
            .query_row(
                "select coalesce(max(ordinal),-1)+1 from chat_messages where item_id=?1",
                [item_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let now = now();
        tx.execute("insert into workbench_runs(run_id,item_id,turn_index,invocation_kind,cached_status,submission_state,created_at,updated_at) values(?1,?2,?3,'chat','reserved','reserved',?4,?4)",params![run_id,item_id,ordinal,now]).map_err(|e|e.to_string())?;
        tx.execute("insert into chat_messages(id,item_id,ordinal,role,content_json,run_id,created_at) values(?1,?2,?3,'user',?4,?5,?6)",params![uuid::Uuid::new_v4().to_string(),item_id,ordinal,serde_json::to_string(content).map_err(|e|e.to_string())?,run_id,now]).map_err(|e|e.to_string())?;
        tx.execute(
            "update workbench_items set updated_at=?2 where id=?1",
            params![item_id, now],
        )
        .map_err(|e| e.to_string())?;
        let messages = load_messages(&tx, item_id)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(messages)
    }

    pub fn finalize_chat_success(
        &self,
        run_id: &str,
        stored_result: &serde_json::Value,
        assistant_output: &str,
    ) -> Result<bool, String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (item_id, turn_index, status, submission, prior_result): (
            String,
            i64,
            String,
            String,
            Option<String>,
        ) = tx
            .query_row(
                "select item_id,turn_index,cached_status,submission_state,result_json from workbench_runs where run_id=?1 and invocation_kind='chat'",
                [run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map_err(|e| e.to_string())?;
        let result_json = stored_result.to_string();
        if status == "succeeded"
            && submission == "terminal"
            && prior_result.as_deref() != Some(result_json.as_str())
        {
            return Err("The chat run was already finalized with a different result.".into());
        }
        let ordinal = turn_index + 1;
        let encoded = serde_json::to_string(assistant_output).map_err(|e| e.to_string())?;
        use rusqlite::OptionalExtension;
        let existing: Option<(String, String, Option<String>)> = tx
            .query_row(
                "select role,content_json,run_id from chat_messages where item_id=?1 and ordinal=?2",
                params![item_id, ordinal],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let changed = match existing {
            Some((role, content, owner))
                if role == "assistant"
                    && content == encoded
                    && owner.as_deref() == Some(run_id) =>
            {
                false
            }
            Some(_) => {
                return Err(
                    "The assistant ordinal is occupied by a different message or run.".into(),
                )
            }
            None => {
                tx.execute("insert into chat_messages(id,item_id,ordinal,role,content_json,run_id,created_at) values(?1,?2,?3,'assistant',?4,?5,?6)",params![uuid::Uuid::new_v4().to_string(),item_id,ordinal,encoded,run_id,now()]).map_err(|e|e.to_string())?;
                true
            }
        };
        let timestamp = now();
        tx.execute("update workbench_runs set result_json=?2,cached_status='succeeded',submission_state='terminal',updated_at=?3 where run_id=?1", params![run_id, result_json, timestamp]).map_err(|e|e.to_string())?;
        tx.execute(
            "update workbench_items set updated_at=?2 where id=?1",
            params![item_id, timestamp],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    pub fn mark_submission_failed(&self, run_id: &str) -> Result<(), String> {
        let changed = self.connection.lock().unwrap().execute(
            "update workbench_runs set cached_status='submission_failed',submission_state='submission_failed',updated_at=?2 where run_id=?1",
            params![run_id, now()],
        ).map_err(|e|e.to_string())?;
        if changed == 0 {
            return Err("Run is not known.".into());
        }
        Ok(())
    }

    pub fn delete_item(&self, item_id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute("delete from workbench_items where id=?1", [item_id])
            .map_err(|e| e.to_string())?;
        Ok(())
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

    pub fn set_cancel_requested(&self, run_id: &str) -> Result<(), String> {
        let changed = self
            .connection
            .lock()
            .unwrap()
            .execute(
                "update workbench_runs set cancel_requested=1,updated_at=?2 where run_id=?1",
                params![run_id, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Run is not known.".into());
        }
        Ok(())
    }

    pub fn store_result(&self, run_id: &str, result: &serde_json::Value) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "update workbench_runs set result_json=?2,updated_at=?3 where run_id=?1",
                params![run_id, result.to_string(), now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_result(&self, run_id: &str) -> Result<Option<serde_json::Value>, String> {
        use rusqlite::OptionalExtension;
        let json: Option<Option<String>> = self
            .connection
            .lock()
            .unwrap()
            .query_row(
                "select result_json from workbench_runs where run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        json.flatten()
            .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            .transpose()
    }

    pub fn set_interrupt_pending(&self, run_id: &str, pending: bool) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "update workbench_runs set interrupt_pending=?2,updated_at=?3 where run_id=?1",
                params![run_id, pending, now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_runs(&self) -> Result<Vec<Reservation>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select i.id,r.run_id,i.title,i.session_id,i.pinned_agent_id,i.pinned_agent_name,i.pinned_agent_fingerprint,r.invocation_kind,r.cached_status,r.submission_state,r.cancel_requested,r.interrupt_pending from workbench_runs r join workbench_items i on i.id=r.item_id order by r.created_at,r.run_id").map_err(|e| e.to_string())?;
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
                    cancel_requested: r.get(10)?,
                    interrupt_pending: r.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn save_pending_approval(&self, value: &PendingApproval) -> Result<(), String> {
        self.connection.lock().unwrap().execute("insert into pending_approvals(root_run_id,approval_run_id,approval_id,parent_run_id,tool_name,message,decision_in_flight,decision,operation_state,updated_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) on conflict(root_run_id) do update set approval_run_id=excluded.approval_run_id,approval_id=excluded.approval_id,parent_run_id=excluded.parent_run_id,tool_name=excluded.tool_name,message=excluded.message,decision_in_flight=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.decision_in_flight else excluded.decision_in_flight end,decision=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.decision else excluded.decision end,operation_state=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.operation_state else excluded.operation_state end,updated_at=excluded.updated_at", params![value.root_run_id,value.approval_run_id,value.approval_id,value.parent_run_id,value.tool_name,value.message,value.decision_in_flight,value.decision,value.operation_state,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn load_pending_approvals(&self) -> Result<Vec<PendingApproval>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement=connection.prepare("select root_run_id,approval_run_id,approval_id,parent_run_id,tool_name,message,decision_in_flight,decision,operation_state from pending_approvals order by root_run_id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok(PendingApproval {
                    root_run_id: r.get(0)?,
                    approval_run_id: r.get(1)?,
                    approval_id: r.get(2)?,
                    parent_run_id: r.get(3)?,
                    tool_name: r.get(4)?,
                    message: r.get(5)?,
                    decision_in_flight: r.get(6)?,
                    decision: r.get(7)?,
                    operation_state: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn begin_approval_decision(
        &self,
        root_run_id: &str,
        approval_run_id: &str,
        approval_id: &str,
        approved: bool,
    ) -> Result<bool, String> {
        let changed=self.connection.lock().unwrap().execute("update pending_approvals set decision_in_flight=1,decision=?4,operation_state='resolving',updated_at=?5 where root_run_id=?1 and approval_run_id=?2 and approval_id=?3 and operation_state='awaiting_decision'",params![root_run_id,approval_run_id,approval_id,approved,now()]).map_err(|e|e.to_string())?;
        Ok(changed == 1)
    }
    pub fn mark_approval_resolved(
        &self,
        root_run_id: &str,
        approval_run_id: &str,
        approval_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let state = if approved {
            "resume_pending"
        } else {
            "rejection_pending"
        };
        self.connection.lock().unwrap().execute("update pending_approvals set operation_state=?4,updated_at=?5 where root_run_id=?1 and approval_run_id=?2 and approval_id=?3 and operation_state='resolving'",params![root_run_id,approval_run_id,approval_id,state,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn clear_pending_approval(
        &self,
        root_run_id: &str,
        approval_id: Option<&str>,
    ) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "delete from pending_approvals where root_run_id=?1 and (?2 is null or approval_id=?2)",
                params![root_run_id, approval_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn load_messages(connection: &Connection, item_id: &str) -> Result<Vec<ChatMessage>, String> {
    let mut statement = connection.prepare("select id,ordinal,role,content_json,run_id from chat_messages where item_id=?1 order by ordinal").map_err(|e|e.to_string())?;
    let messages = statement
        .query_map([item_id], |r| {
            let encoded: String = r.get(3)?;
            Ok(ChatMessage {
                id: r.get(0)?,
                ordinal: r.get(1)?,
                role: r.get(2)?,
                content: serde_json::from_str::<String>(&encoded).unwrap_or(encoded),
                run_id: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(messages)
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
            cancel_requested: false,
            interrupt_pending: false,
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
    fn pending_approval_survives_reopen_and_decision_guard_is_atomic() {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let db = WorkbenchDb::open(file.path()).unwrap();
            db.reserve_task(&reservation()).unwrap();
            db.save_pending_approval(&PendingApproval {
                root_run_id: "run".into(),
                approval_run_id: "child".into(),
                approval_id: "child:call".into(),
                parent_run_id: Some("run".into()),
                tool_name: "shell".into(),
                message: "Allow?".into(),
                decision_in_flight: false,
                decision: None,
                operation_state: "awaiting_decision".into(),
            })
            .unwrap();
        }
        let db = WorkbenchDb::open(file.path()).unwrap();
        assert_eq!(
            db.load_pending_approvals().unwrap()[0].approval_run_id,
            "child"
        );
        assert!(db
            .begin_approval_decision("run", "child", "child:call", true)
            .unwrap());
        assert!(!db
            .begin_approval_decision("run", "child", "child:call", true)
            .unwrap());
        assert!(!db
            .begin_approval_decision("run", "wrong", "child:call", true)
            .unwrap());
        let pending = &db.load_pending_approvals().unwrap()[0];
        assert_eq!(pending.decision, Some(true));
        assert_eq!(pending.operation_state, "resolving");
        db.save_pending_approval(&PendingApproval {
            root_run_id: "run".into(),
            approval_run_id: "child".into(),
            approval_id: "child:call".into(),
            parent_run_id: Some("run".into()),
            tool_name: "shell".into(),
            message: "Allow?".into(),
            decision_in_flight: false,
            decision: None,
            operation_state: "awaiting_decision".into(),
        })
        .unwrap();
        let pending = &db.load_pending_approvals().unwrap()[0];
        assert!(pending.decision_in_flight);
        assert_eq!(pending.decision, Some(true));
        assert_eq!(pending.operation_state, "resolving");
        db.mark_approval_resolved("run", "child", "child:call", true)
            .unwrap();
        assert_eq!(
            WorkbenchDb::open(file.path())
                .unwrap()
                .load_pending_approvals()
                .unwrap()[0]
                .operation_state,
            "resume_pending"
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
                "insert into workbench_runs(run_id,item_id,turn_index,invocation_kind,cached_status,submission_state,created_at,updated_at) values('r','missing',null,'run','x','x','x','x')",
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

    fn chat() -> ChatItem {
        ChatItem {
            item_id: "chat".into(),
            title: "Chat".into(),
            session_id: "session-stable".into(),
            pinned_agent_id: "agent".into(),
            pinned_agent_name: "Agent".into(),
            pinned_agent_fingerprint: "fingerprint".into(),
        }
    }

    #[test]
    fn chat_pin_session_and_complete_transcript_survive_reopen() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let db = WorkbenchDb::open(file.path()).unwrap();
        db.create_chat(&chat()).unwrap();
        let first = db.reserve_chat_turn("chat", "run-1", "hello").unwrap();
        assert_eq!(
            first
                .iter()
                .map(|m| (m.role.as_str(), m.content.as_str()))
                .collect::<Vec<_>>(),
            vec![("user", "hello")]
        );
        db.finalize_chat_success("run-1", &serde_json::json!({"answer":"hi"}), "hi")
            .unwrap();
        drop(db);
        let (saved, messages) = WorkbenchDb::open(file.path())
            .unwrap()
            .load_chat("chat")
            .unwrap();
        assert_eq!(saved, chat());
        assert_eq!(
            messages
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["hello", "hi"]
        );
    }

    #[test]
    fn same_chat_rejects_overlap_and_assistant_is_idempotent() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.create_chat(&chat()).unwrap();
        db.reserve_chat_turn("chat", "run-1", "hello").unwrap();
        assert!(db
            .reserve_chat_turn("chat", "run-2", "overlap")
            .unwrap_err()
            .contains("in progress"));
        assert!(db
            .finalize_chat_success("run-1", &serde_json::json!("answer"), "answer")
            .unwrap());
        assert!(!db
            .finalize_chat_success("run-1", &serde_json::json!("answer"), "answer")
            .unwrap());
        assert!(db
            .finalize_chat_success("run-1", &serde_json::json!("different"), "duplicate")
            .is_err());
        assert_eq!(db.load_chat("chat").unwrap().1.len(), 2);
    }

    #[test]
    fn finalize_is_atomic_and_submission_failure_preserves_user_and_allows_next_turn() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.create_chat(&chat()).unwrap();
        db.reserve_chat_turn("chat", "run-1", "one").unwrap();
        assert!(db.reserve_chat_turn("chat", "run-2", "two").is_err());
        db.finalize_chat_success("run-1", &serde_json::json!({"output":"ok"}), "ok")
            .unwrap();
        let transcript = db.reserve_chat_turn("chat", "run-2", "two").unwrap();
        assert_eq!(
            transcript
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "ok", "two"]
        );
        db.mark_submission_failed("run-2").unwrap();
        db.reserve_chat_turn("chat", "run-3", "three").unwrap();
        assert_eq!(
            db.load_chat("chat")
                .unwrap()
                .1
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "ok", "two", "three"]
        );
    }

    #[test]
    fn durable_completed_chat_is_repaired_after_reopen_and_ordinal_mismatch_is_rejected() {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let db = WorkbenchDb::open(file.path()).unwrap();
            db.create_chat(&chat()).unwrap();
            db.reserve_chat_turn("chat", "run-1", "one").unwrap();
        }
        let db = WorkbenchDb::open(file.path()).unwrap();
        db.finalize_chat_success("run-1", &serde_json::json!({"answer":1}), "recovered")
            .unwrap();
        assert_eq!(db.load_runs().unwrap()[0].submission_state, "terminal");
        db.reserve_chat_turn("chat", "run-2", "two").unwrap();
        db.connection.lock().unwrap().execute("insert into chat_messages(id,item_id,ordinal,role,content_json,run_id,created_at) values('collision','chat',3,'user','\"collision\"',null,'now')",[]).unwrap();
        assert!(db
            .finalize_chat_success("run-2", &serde_json::json!(2), "answer")
            .unwrap_err()
            .contains("occupied"));
    }
}
