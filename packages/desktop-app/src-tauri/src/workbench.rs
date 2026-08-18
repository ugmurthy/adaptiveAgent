use crate::attachments::AttachmentDraft;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
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
), (
    6,
    "alter table deletion_jobs add column operation_json text;",
) ,(
    7,
    "create table run_recovery_operations (run_id text primary key references workbench_runs(run_id) on delete cascade, requested_action text not null check(requested_action in ('resume','retry')), baseline_event_seq integer not null, updated_at text not null);",
), (
    8,
    "alter table workbench_runs add column workspace_root text; alter table workbench_runs add column shell_cwd text;",
), (
    9,
    r#"alter table workbench_items add column workspace_root text;
alter table workbench_items add column shell_cwd text;
alter table workbench_runs add column execution_mode text not null default 'direct' check(execution_mode in ('direct','catalog'));
alter table workbench_runs add column final_run_id text;
alter table workbench_runs add column trace_target_json text;
create table attachments (attachment_id text primary key, staged_relative_path text not null unique, display_name text not null, kind text not null check(kind in ('file','image','audio')), mime_type text, audio_format text, size_bytes integer not null, sha256 text not null, state text not null check(state in ('draft','owned','delete_pending')), created_at text not null, claimed_at text);
create table task_attachments (item_id text not null references workbench_items(id) on delete cascade, attachment_id text not null unique references attachments(attachment_id), ordinal integer not null, primary key(item_id,ordinal));
create table message_attachments (message_id text not null references chat_messages(id) on delete cascade, attachment_id text not null unique references attachments(attachment_id), ordinal integer not null, primary key(message_id,ordinal));
create trigger task_attachment_delete before delete on task_attachments begin update attachments set state='delete_pending' where attachment_id=old.attachment_id; end;
create trigger message_attachment_delete before delete on message_attachments begin update attachments set state='delete_pending' where attachment_id=old.attachment_id; end;
update workbench_runs set final_run_id=run_id,trace_target_json=json_object('kind','root-run','rootRunId',run_id);"#,
) ,(
    10,
    r#"alter table workbench_items add column pinned_agent_config_path text;
alter table workbench_runs add column agent_id text;
alter table workbench_runs add column agent_config_path text;
alter table workbench_runs add column agent_fingerprint text;
update workbench_runs
set agent_id=(select pinned_agent_id from workbench_items where id=workbench_runs.item_id),
    agent_config_path=(select pinned_agent_config_path from workbench_items where id=workbench_runs.item_id),
    agent_fingerprint=(select pinned_agent_fingerprint from workbench_items where id=workbench_runs.item_id);"#,
) ,(
    11,
    r#"create index workbench_items_agent_updated on workbench_items(pinned_agent_id,updated_at desc,id);
create index workbench_runs_agent_created on workbench_runs(agent_id,created_at,run_id);
create index workbench_runs_agent_item on workbench_runs(agent_id,item_id);
alter table attachments add column owner_agent_id text;
alter table deletion_jobs add column agent_id text;
update attachments
set owner_agent_id=coalesce(
  (select i.pinned_agent_id from task_attachments t join workbench_items i on i.id=t.item_id where t.attachment_id=attachments.attachment_id),
  (select i.pinned_agent_id from message_attachments m join chat_messages c on c.id=m.message_id join workbench_items i on i.id=c.item_id where m.attachment_id=attachments.attachment_id)
)
where state='owned';
update deletion_jobs
set agent_id=coalesce(
  (select pinned_agent_id from workbench_items where id=deletion_jobs.item_id),
  (select agent_id from workbench_runs where run_id=deletion_jobs.root_run_id)
)
where agent_id is null;
create index attachments_agent_state on attachments(owner_agent_id,state,created_at);
create index deletion_jobs_agent_state on deletion_jobs(agent_id,state,created_at,id);"#,
)];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCatalogMapping {
    pub agent_id: String,
    pub fingerprint: String,
    pub config_path: String,
}

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
    pub created_at: String,
    pub session_id: String,
    pub pinned_agent_id: String,
    pub pinned_agent_name: String,
    pub pinned_agent_fingerprint: String,
    pub pinned_agent_config_path: Option<String>,
    pub workspace_root: Option<String>,
    pub shell_cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub ordinal: i64,
    pub role: String,
    pub content: String,
    pub run_id: Option<String>,
    pub attachments: Vec<AttachmentDraft>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reservation {
    pub item_id: String,
    pub run_id: String,
    pub title: String,
    pub created_at: String,
    pub session_id: Option<String>,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_fingerprint: String,
    pub agent_config_path: Option<String>,
    pub invocation_kind: String,
    pub cached_status: String,
    pub submission_state: String,
    pub cancel_requested: bool,
    pub interrupt_pending: bool,
    pub workspace_root: Option<String>,
    pub shell_cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingRunRecovery {
    pub run_id: String,
    pub requested_action: String,
    pub baseline_event_seq: i64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionJob {
    pub id: String,
    pub operation: Value,
    pub last_error: Option<String>,
}

pub struct WorkbenchDb {
    connection: Mutex<Connection>,
}

const AGENT_RUN_CAPACITY: i64 = 3;

fn assert_agent_capacity(tx: &rusqlite::Transaction<'_>, agent_id: &str) -> Result<(), String> {
    let occupied: i64 = tx
        .query_row(
            "select count(*) from workbench_runs where agent_id=?1 and submission_state not in ('terminal','submission_failed')",
            [agent_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if occupied >= AGENT_RUN_CAPACITY {
        Err("All 3 task slots are occupied. Stop or wait for a run, then try again.".into())
    } else {
        Ok(())
    }
}

impl WorkbenchDb {
    pub fn insert_draft_for_agent(
        &self,
        agent_id: &str,
        draft: &AttachmentDraft,
    ) -> Result<(), String> {
        self.connection.lock().unwrap().execute("insert into attachments(attachment_id,staged_relative_path,display_name,kind,mime_type,audio_format,size_bytes,sha256,state,created_at,owner_agent_id) values(?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9,?10)",params![draft.id,draft.staged_relative_path,draft.name,draft.kind,draft.mime_type,draft.audio_format,draft.size_bytes,draft.sha256,now(),agent_id]).map_err(|e|e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_draft(&self, draft: &AttachmentDraft) -> Result<(), String> {
        self.connection.lock().unwrap().execute("insert into attachments(attachment_id,staged_relative_path,display_name,kind,mime_type,audio_format,size_bytes,sha256,state,created_at) values(?1,?2,?3,?4,?5,?6,?7,?8,'draft',?9)",params![draft.id,draft.staged_relative_path,draft.name,draft.kind,draft.mime_type,draft.audio_format,draft.size_bytes,draft.sha256,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn get_drafts(&self, ids: &[String]) -> Result<Vec<AttachmentDraft>, String> {
        let connection = self.connection.lock().unwrap();
        let mut output = Vec::new();
        for id in ids {
            let draft=connection.query_row("select attachment_id,display_name,kind,size_bytes,mime_type,staged_relative_path,sha256,audio_format from attachments where attachment_id=?1 and state='draft'",[id],|r|Ok(AttachmentDraft{id:r.get(0)?,name:r.get(1)?,kind:r.get(2)?,size_bytes:r.get(3)?,mime_type:r.get(4)?,staged_relative_path:r.get(5)?,sha256:r.get(6)?,audio_format:r.get(7)?})).optional().map_err(|e|e.to_string())?.ok_or("ATTACHMENT_NOT_FOUND")?;
            output.push(draft);
        }
        Ok(output)
    }

    pub fn get_drafts_for_agent(
        &self,
        agent_id: &str,
        ids: &[String],
    ) -> Result<Vec<AttachmentDraft>, String> {
        let connection = self.connection.lock().unwrap();
        let mut output = Vec::new();
        for id in ids {
            let draft=connection.query_row("select attachment_id,display_name,kind,size_bytes,mime_type,staged_relative_path,sha256,audio_format from attachments where attachment_id=?1 and owner_agent_id=?2 and state='draft'",params![id,agent_id],|r|Ok(AttachmentDraft{id:r.get(0)?,name:r.get(1)?,kind:r.get(2)?,size_bytes:r.get(3)?,mime_type:r.get(4)?,staged_relative_path:r.get(5)?,sha256:r.get(6)?,audio_format:r.get(7)?})).optional().map_err(|e|e.to_string())?.ok_or("ATTACHMENT_NOT_FOUND")?;
            output.push(draft);
        }
        Ok(output)
    }

    pub fn task_attachments_for_run(&self, run_id: &str) -> Result<Vec<AttachmentDraft>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select a.attachment_id,a.display_name,a.kind,a.size_bytes,a.mime_type,a.staged_relative_path,a.sha256,a.audio_format from workbench_runs r join task_attachments t on t.item_id=r.item_id join attachments a on a.attachment_id=t.attachment_id where r.run_id=?1 and a.state='owned' order by t.ordinal").map_err(|e|e.to_string())?;
        let attachments = statement
            .query_map([run_id], |r| {
                Ok(AttachmentDraft {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    size_bytes: r.get(3)?,
                    mime_type: r.get(4)?,
                    staged_relative_path: r.get(5)?,
                    sha256: r.get(6)?,
                    audio_format: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(attachments)
    }

    #[cfg(test)]
    pub fn discard_draft(&self, id: &str) -> Result<Option<String>, String> {
        let connection = self.connection.lock().unwrap();
        let path=connection.query_row("select staged_relative_path from attachments where attachment_id=?1 and state='draft'",[id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if path.is_some() {
            connection
                .execute(
                    "update attachments set state='delete_pending' where attachment_id=?1 and state='draft'",
                    [id],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(path)
    }

    pub fn discard_draft_for_agent(
        &self,
        agent_id: &str,
        id: &str,
    ) -> Result<Option<String>, String> {
        let connection = self.connection.lock().unwrap();
        let path=connection.query_row("select staged_relative_path from attachments where attachment_id=?1 and owner_agent_id=?2 and state='draft'",params![id,agent_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if path.is_some() {
            connection.execute("update attachments set state='delete_pending' where attachment_id=?1 and owner_agent_id=?2 and state='draft'",params![id,agent_id]).map_err(|e|e.to_string())?;
        }
        Ok(path)
    }

    pub fn attachment_cleanup_candidates(&self) -> Result<Vec<(String, String)>, String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute("update attachments set state='delete_pending' where state='draft' and cast(created_at as integer) < unixepoch('now') * 1000 - 86400000", []).map_err(|e|e.to_string())?;
        let mut statement = tx.prepare("select attachment_id,staged_relative_path from attachments where state='delete_pending'").map_err(|e|e.to_string())?;
        let candidates = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);
        tx.commit().map_err(|e| e.to_string())?;
        Ok(candidates)
    }

    pub fn attachment_managed_directories(&self) -> Result<Vec<String>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("select staged_relative_path from attachments")
            .map_err(|e| e.to_string())?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(paths
            .into_iter()
            .filter_map(|path| {
                Path::new(&path)
                    .components()
                    .next()
                    .and_then(|component| match component {
                        std::path::Component::Normal(directory) => {
                            Some(directory.to_string_lossy().into_owned())
                        }
                        _ => None,
                    })
            })
            .collect())
    }

    pub fn finish_attachment_cleanup(&self, id: &str) -> Result<(), String> {
        self.connection.lock().unwrap().execute("delete from attachments where attachment_id=?1 and (state='delete_pending' or state='draft')", [id]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
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

    #[cfg(test)]
    pub fn backfill_agent_config_path(
        &self,
        agent_id: &str,
        agent_fingerprint: &str,
        agent_config_path: &str,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        tx.execute(
            "update workbench_items set pinned_agent_config_path=?3 where pinned_agent_id=?1 and pinned_agent_fingerprint=?2 and pinned_agent_config_path is null",
            params![agent_id, agent_fingerprint, agent_config_path],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "update workbench_runs set agent_config_path=?3 where agent_id=?1 and agent_fingerprint=?2 and agent_config_path is null",
            params![agent_id, agent_fingerprint, agent_config_path],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    /// Reconciles the complete active and archived catalog. Callers should remove
    /// duplicate triples before calling; repeated mappings remain harmless.
    pub fn reconcile_agent_catalog(&self, mappings: &[AgentCatalogMapping]) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for mapping in mappings {
            tx.execute("update workbench_items set pinned_agent_config_path=?3 where pinned_agent_id=?1 and pinned_agent_fingerprint=?2 and pinned_agent_config_path is null",params![mapping.agent_id,mapping.fingerprint,mapping.config_path]).map_err(|e|e.to_string())?;
            tx.execute("update workbench_runs set agent_config_path=?3 where agent_id=?1 and agent_fingerprint=?2 and agent_config_path is null",params![mapping.agent_id,mapping.fingerprint,mapping.config_path]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Terminates active work whose immutable generation cannot be recreated from the
    /// complete current catalog. The state transition and stale-operation cleanup are
    /// atomic; historical results are intentionally left untouched.
    pub fn interrupt_orphaned_generations(
        &self,
        mappings: &[AgentCatalogMapping],
    ) -> Result<Vec<String>, String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute_batch("create temp table if not exists recreatable_generations(agent_id text not null,config_path text not null,fingerprint text not null,primary key(agent_id,config_path,fingerprint)); delete from recreatable_generations;").map_err(|e|e.to_string())?;
        for mapping in mappings {
            tx.execute(
                "insert or ignore into recreatable_generations values(?1,?2,?3)",
                params![mapping.agent_id, mapping.config_path, mapping.fingerprint],
            )
            .map_err(|e| e.to_string())?;
        }
        let mut statement = tx.prepare("select run_id from workbench_runs r where submission_state not in ('terminal','submission_failed') and not exists(select 1 from recreatable_generations g where g.agent_id=r.agent_id and g.config_path=r.agent_config_path and g.fingerprint=r.agent_fingerprint) order by run_id").map_err(|e|e.to_string())?;
        let run_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);
        for run_id in &run_ids {
            tx.execute(
                "delete from pending_approvals where root_run_id=?1",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "delete from run_recovery_operations where run_id=?1",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("update workbench_runs set cached_status='interrupted',submission_state='terminal',cancel_requested=0,interrupt_pending=0,updated_at=?2 where run_id=?1",params![run_id,now()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(run_ids)
    }

    pub fn generation_has_pending_operations(
        &self,
        agent_id: &str,
        config_path: &str,
        fingerprint: &str,
    ) -> Result<bool, String> {
        self.connection.lock().unwrap().query_row(
            "select exists(select 1 from workbench_runs r where r.agent_id=?1 and r.agent_config_path=?2 and r.agent_fingerprint=?3 and (exists(select 1 from run_recovery_operations o where o.run_id=r.run_id) or exists(select 1 from deletion_jobs d,json_each(d.operation_json,'$.workbenchRunIds') j where d.state='pending' and d.agent_id=?1 and j.value=r.run_id)))",
            params![agent_id,config_path,fingerprint], |row| row.get(0)
        ).map_err(|e|e.to_string())
    }

    #[cfg(test)]
    pub fn reserve_task(&self, reservation: &Reservation) -> Result<(), String> {
        self.reserve_task_with_attachments(reservation, &[])
    }

    pub fn reserve_task_with_attachments(
        &self,
        reservation: &Reservation,
        attachment_ids: &[String],
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        assert_agent_capacity(&tx, &reservation.agent_id)?;
        tx.execute("insert into workbench_items(id,kind,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,pinned_agent_config_path,created_at,updated_at) values(?1,'task',?2,?3,?4,?5,?6,?7,?8,?8)", params![reservation.item_id,reservation.title,reservation.session_id,reservation.agent_id,reservation.agent_name,reservation.agent_fingerprint,reservation.agent_config_path,reservation.created_at]).map_err(|e| e.to_string())?;
        tx.execute("insert into workbench_runs(run_id,item_id,invocation_kind,cached_status,submission_state,created_at,updated_at,workspace_root,shell_cwd,execution_mode,final_run_id,trace_target_json,agent_id,agent_config_path,agent_fingerprint) values(?1,?2,?3,?4,?5,?6,?6,?7,?8,'direct',?1,json_object('kind','root-run','rootRunId',?1),?9,?10,?11)", params![reservation.run_id,reservation.item_id,reservation.invocation_kind,reservation.cached_status,reservation.submission_state,reservation.created_at,reservation.workspace_root,reservation.shell_cwd,reservation.agent_id,reservation.agent_config_path,reservation.agent_fingerprint]).map_err(|e| e.to_string())?;
        claim_attachments(
            &tx,
            attachment_ids,
            &reservation.agent_id,
            "task_attachments",
            "item_id",
            &reservation.item_id,
        )?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn create_chat(&self, chat: &ChatItem) -> Result<(), String> {
        self.connection.lock().unwrap().execute("insert into workbench_items(id,kind,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,pinned_agent_config_path,created_at,updated_at,workspace_root,shell_cwd) values(?1,'chat',?2,?3,?4,?5,?6,?7,?8,?8,?9,?10)", params![chat.item_id,chat.title,chat.session_id,chat.pinned_agent_id,chat.pinned_agent_name,chat.pinned_agent_fingerprint,chat.pinned_agent_config_path,chat.created_at,chat.workspace_root,chat.shell_cwd]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_chats(&self) -> Result<Vec<ChatItem>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select id,title,created_at,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,pinned_agent_config_path,workspace_root,shell_cwd from workbench_items where kind='chat' order by updated_at desc,id").map_err(|e| e.to_string())?;
        let chats = statement
            .query_map([], |r| {
                Ok(ChatItem {
                    item_id: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    session_id: r.get(3)?,
                    pinned_agent_id: r.get(4)?,
                    pinned_agent_name: r.get(5)?,
                    pinned_agent_fingerprint: r.get(6)?,
                    pinned_agent_config_path: r.get(7)?,
                    workspace_root: r.get(8)?,
                    shell_cwd: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(chats)
    }

    pub fn list_chats_for_agent(&self, agent_id: &str) -> Result<Vec<ChatItem>, String> {
        Ok(self
            .list_chats()?
            .into_iter()
            .filter(|chat| chat.pinned_agent_id == agent_id)
            .collect())
    }

    pub fn assert_item_owner(&self, agent_id: &str, item_id: &str) -> Result<(), String> {
        let owned: bool = self
            .connection
            .lock()
            .unwrap()
            .query_row(
                "select exists(select 1 from workbench_items where id=?1 and pinned_agent_id=?2)",
                params![item_id, agent_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if owned {
            Ok(())
        } else {
            Err("History item was not found for this agent.".into())
        }
    }

    pub fn assert_run_owner(&self, agent_id: &str, run_id: &str) -> Result<(), String> {
        let owned: bool = self
            .connection
            .lock()
            .unwrap()
            .query_row(
                "select exists(select 1 from workbench_runs where run_id=?1 and agent_id=?2)",
                params![run_id, agent_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if owned {
            Ok(())
        } else {
            Err("Run was not found for this agent.".into())
        }
    }

    pub fn load_chat(&self, item_id: &str) -> Result<(ChatItem, Vec<ChatMessage>), String> {
        use rusqlite::OptionalExtension;
        let connection = self.connection.lock().unwrap();
        let chat = connection.query_row("select id,title,created_at,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,pinned_agent_config_path,workspace_root,shell_cwd from workbench_items where id=?1 and kind='chat'", [item_id], |r| Ok(ChatItem { item_id:r.get(0)?, title:r.get(1)?, created_at:r.get(2)?, session_id:r.get(3)?, pinned_agent_id:r.get(4)?, pinned_agent_name:r.get(5)?, pinned_agent_fingerprint:r.get(6)?, pinned_agent_config_path:r.get(7)?, workspace_root:r.get(8)?, shell_cwd:r.get(9)? })).optional().map_err(|e| e.to_string())?.ok_or("Chat was not found.")?;
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
                    attachments: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut messages = messages;
        for message in &mut messages {
            message.attachments = load_message_attachments(&connection, &message.id)?;
        }
        Ok((chat, messages))
    }

    pub fn load_chat_for_agent(
        &self,
        agent_id: &str,
        item_id: &str,
    ) -> Result<(ChatItem, Vec<ChatMessage>), String> {
        self.assert_item_owner(agent_id, item_id)?;
        self.load_chat(item_id)
    }

    #[cfg(test)]
    pub fn reserve_chat_turn(
        &self,
        item_id: &str,
        run_id: &str,
        content: &str,
    ) -> Result<Vec<ChatMessage>, String> {
        self.reserve_chat_turn_with_attachments(item_id, run_id, content, &[])
    }

    pub fn reserve_chat_turn_with_attachments(
        &self,
        item_id: &str,
        run_id: &str,
        content: &str,
        attachment_ids: &[String],
    ) -> Result<Vec<ChatMessage>, String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let agent_id: String = tx
            .query_row(
                "select pinned_agent_id from workbench_items where id=?1 and kind='chat'",
                [item_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        assert_agent_capacity(&tx, &agent_id)?;
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
        tx.execute("insert into workbench_runs(run_id,item_id,turn_index,invocation_kind,cached_status,submission_state,created_at,updated_at,execution_mode,final_run_id,trace_target_json,workspace_root,shell_cwd,agent_id,agent_config_path,agent_fingerprint) select ?1,?2,?3,'chat','reserved','reserved',?4,?4,'direct',?1,json_object('kind','root-run','rootRunId',?1),workspace_root,shell_cwd,pinned_agent_id,pinned_agent_config_path,pinned_agent_fingerprint from workbench_items where id=?2",params![run_id,item_id,ordinal,now]).map_err(|e|e.to_string())?;
        let message_id = uuid::Uuid::new_v4().to_string();
        tx.execute("insert into chat_messages(id,item_id,ordinal,role,content_json,run_id,created_at) values(?1,?2,?3,'user',?4,?5,?6)",params![message_id,item_id,ordinal,serde_json::to_string(content).map_err(|e|e.to_string())?,run_id,now]).map_err(|e|e.to_string())?;
        claim_attachments(
            &tx,
            attachment_ids,
            &tx.query_row(
                "select pinned_agent_id from workbench_items where id=?1",
                [item_id],
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?,
            "message_attachments",
            "message_id",
            &message_id,
        )?;
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

    #[cfg(test)]
    pub fn delete_item(&self, item_id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute("delete from workbench_items where id=?1", [item_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub fn delete_item_for_agent(&self, agent_id: &str, item_id: &str) -> Result<(), String> {
        self.assert_item_owner(agent_id, item_id)?;
        self.delete_item(item_id)
    }

    pub fn item_deletion_operation(&self, item_id: &str) -> Result<Value, String> {
        let connection = self.connection.lock().unwrap();
        let (kind, title, session_id): (String, String, Option<String>) = connection
            .query_row(
                "select kind,title,session_id from workbench_items where id=?1",
                [item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or("History item was not found.")?;
        let mut statement = connection
            .prepare(
                "select run_id from workbench_runs where item_id=?1 order by case when ?2='chat' then turn_index end desc,case when ?2<>'chat' then created_at end,case when ?2<>'chat' then run_id end",
            )
            .map_err(|error| error.to_string())?;
        let run_ids = statement
            .query_map(params![item_id, kind], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let targets = if kind == "chat" {
            vec![
                serde_json::json!({"kind":"session","sessionId":session_id.ok_or("Chat session is missing.")?}),
            ]
        } else {
            run_ids
                .iter()
                .map(|run_id| serde_json::json!({"kind":"root-run","rootRunId":run_id}))
                .collect()
        };
        Ok(
            serde_json::json!({"kind":"item","itemId":item_id,"label":title,"workbenchRunIds":run_ids,"runtimeTargets":targets}),
        )
    }

    pub fn run_deletion_operation(&self, run_id: &str) -> Result<Value, String> {
        let connection = self.connection.lock().unwrap();
        let (item_id, invocation_kind): (String, String) = connection
            .query_row(
                "select item_id,invocation_kind from workbench_runs where run_id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or("Run history was not found.")?;
        if invocation_kind == "chat" {
            return Err("Delete a chat turn instead of deleting its run directly.".into());
        }
        Ok(
            serde_json::json!({"kind":"run","itemId":item_id,"runId":run_id,"workbenchRunIds":[run_id],"runtimeTargets":[{"kind":"root-run","rootRunId":run_id}]}),
        )
    }

    pub fn chat_turn_deletion_operation(
        &self,
        item_id: &str,
        ordinal: i64,
    ) -> Result<Value, String> {
        let connection = self.connection.lock().unwrap();
        let role: Option<String> = connection
            .query_row(
                "select role from chat_messages where item_id=?1 and ordinal=?2",
                params![item_id, ordinal],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if role.as_deref() != Some("user") {
            return Err("Chat deletion must begin at a user turn.".into());
        }
        let mut statement = connection
            .prepare("select run_id from workbench_runs where item_id=?1 and invocation_kind='chat' and turn_index>=?2 order by turn_index desc")
            .map_err(|error| error.to_string())?;
        let targets = statement
            .query_map(params![item_id, ordinal], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|run_id| serde_json::json!({"kind":"root-run","rootRunId":run_id}))
            .collect::<Vec<_>>();
        Ok(
            serde_json::json!({"kind":"chat-turn","itemId":item_id,"fromOrdinal":ordinal,"workbenchRunIds":targets.iter().filter_map(|target|target.get("rootRunId").and_then(Value::as_str)).collect::<Vec<_>>(),"runtimeTargets":targets}),
        )
    }

    #[cfg(test)]
    pub fn create_deletion_job(&self, operation: &Value) -> Result<DeletionJob, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        self.connection.lock().unwrap().execute(
            "insert into deletion_jobs(id,item_id,root_run_id,state,last_error,created_at,updated_at,operation_json) values(?1,?2,null,'pending',null,?3,?3,?4)",
            params![id, operation.get("itemId").and_then(Value::as_str), timestamp, operation.to_string()],
        ).map_err(|error| error.to_string())?;
        Ok(DeletionJob {
            id,
            operation: operation.clone(),
            last_error: None,
        })
    }

    pub fn create_deletion_job_for_agent(
        &self,
        agent_id: &str,
        operation: &Value,
    ) -> Result<DeletionJob, String> {
        if let Some(item_id) = operation.get("itemId").and_then(Value::as_str) {
            self.assert_item_owner(agent_id, item_id)?;
        }
        if let Some(run_id) = operation.get("runId").and_then(Value::as_str) {
            self.assert_run_owner(agent_id, run_id)?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        self.connection.lock().unwrap().execute("insert into deletion_jobs(id,item_id,root_run_id,state,last_error,created_at,updated_at,operation_json,agent_id) values(?1,?2,?3,'pending',null,?4,?4,?5,?6)",params![id,operation.get("itemId").and_then(Value::as_str),operation.get("runId").and_then(Value::as_str),timestamp,operation.to_string(),agent_id]).map_err(|e|e.to_string())?;
        Ok(DeletionJob {
            id,
            operation: operation.clone(),
            last_error: None,
        })
    }

    #[cfg(test)]
    pub fn load_deletion_jobs(&self) -> Result<Vec<DeletionJob>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select id,operation_json,last_error from deletion_jobs where state='pending' and operation_json is not null order by created_at,id").map_err(|error|error.to_string())?;
        let jobs = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .map(|row| {
                let (id, operation, last_error) = row.map_err(|error| error.to_string())?;
                Ok(DeletionJob {
                    id,
                    operation: serde_json::from_str(&operation)
                        .map_err(|error| error.to_string())?,
                    last_error,
                })
            })
            .collect();
        jobs
    }

    pub fn load_deletion_jobs_for_agent(&self, agent_id: &str) -> Result<Vec<DeletionJob>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement=connection.prepare("select id,operation_json,last_error from deletion_jobs where agent_id=?1 and state='pending' and operation_json is not null order by created_at,id").map_err(|e|e.to_string())?;
        let jobs = statement
            .query_map([agent_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .map(|row| {
                let (id, json, last_error) = row.map_err(|e| e.to_string())?;
                Ok(DeletionJob {
                    id,
                    operation: serde_json::from_str(&json).map_err(|e| e.to_string())?,
                    last_error,
                })
            })
            .collect();
        jobs
    }

    pub fn fail_deletion_job(&self, id: &str, error: &str) -> Result<(), String> {
        self.connection.lock().unwrap().execute("update deletion_jobs set last_error=?2,updated_at=?3 where id=?1 and state='pending'",params![id,error,now()]).map_err(|error|error.to_string())?;
        Ok(())
    }

    pub fn complete_deletion_job(&self, job: &DeletionJob) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        match job.operation.get("kind").and_then(Value::as_str) {
            Some("item") => {
                tx.execute(
                    "delete from workbench_items where id=?1",
                    [job.operation
                        .get("itemId")
                        .and_then(Value::as_str)
                        .ok_or("Deletion item is missing.")?],
                )
                .map_err(|error| error.to_string())?;
            }
            Some("run") => {
                tx.execute(
                    "delete from workbench_runs where run_id=?1",
                    [job.operation
                        .get("runId")
                        .and_then(Value::as_str)
                        .ok_or("Deletion run is missing.")?],
                )
                .map_err(|error| error.to_string())?;
            }
            Some("chat-turn") => {
                let item_id = job
                    .operation
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or("Deletion item is missing.")?;
                let ordinal = job
                    .operation
                    .get("fromOrdinal")
                    .and_then(Value::as_i64)
                    .ok_or("Deletion ordinal is missing.")?;
                tx.execute(
                    "delete from chat_messages where item_id=?1 and ordinal>=?2",
                    params![item_id, ordinal],
                )
                .map_err(|error| error.to_string())?;
                tx.execute("delete from workbench_runs where item_id=?1 and invocation_kind='chat' and turn_index>=?2",params![item_id,ordinal]).map_err(|error|error.to_string())?;
                tx.execute(
                    "update workbench_items set updated_at=?2 where id=?1",
                    params![item_id, now()],
                )
                .map_err(|error| error.to_string())?;
            }
            _ => return Err("Deletion operation is invalid.".into()),
        }
        tx.execute("delete from deletion_jobs where id=?1", [job.id.as_str()])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
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

    pub fn begin_same_run_recovery(
        &self,
        run_id: &str,
        requested_action: &str,
        baseline_event_seq: i64,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let agent_id: String = tx
            .query_row(
                "select agent_id from workbench_runs where run_id=?1 and submission_state='terminal'",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|_| "Run is not in a recoverable workbench state.".to_string())?;
        assert_agent_capacity(&tx, &agent_id)?;
        let changed = tx
            .execute(
                "update workbench_runs set cached_status='recovering',submission_state='submitted',cancel_requested=0,interrupt_pending=0,updated_at=?2 where run_id=?1 and submission_state='terminal'",
                params![run_id, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Run is not in a recoverable workbench state.".into());
        }
        tx.execute(
            "delete from pending_approvals where root_run_id=?1",
            [run_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "insert into run_recovery_operations(run_id,requested_action,baseline_event_seq,updated_at) values(?1,?2,?3,?4)",
            params![run_id, requested_action, baseline_event_seq, now()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn load_run_recovery_operations(&self) -> Result<Vec<PendingRunRecovery>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("select run_id,requested_action,baseline_event_seq from run_recovery_operations order by updated_at,run_id")
            .map_err(|e| e.to_string())?;
        let operations = statement
            .query_map([], |row| {
                Ok(PendingRunRecovery {
                    run_id: row.get(0)?,
                    requested_action: row.get(1)?,
                    baseline_event_seq: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(operations)
    }

    pub fn load_run_recovery_operations_for_generation(
        &self,
        agent_id: &str,
        config_path: &str,
        fingerprint: &str,
    ) -> Result<Vec<PendingRunRecovery>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare("select o.run_id,o.requested_action,o.baseline_event_seq from run_recovery_operations o join workbench_runs r on r.run_id=o.run_id where r.agent_id=?1 and r.agent_config_path=?2 and r.agent_fingerprint=?3 order by o.updated_at,o.run_id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(params![agent_id, config_path, fingerprint], |row| {
                Ok(PendingRunRecovery {
                    run_id: row.get(0)?,
                    requested_action: row.get(1)?,
                    baseline_event_seq: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_run_recovery_operation(
        &self,
        run_id: &str,
    ) -> Result<Option<PendingRunRecovery>, String> {
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "select run_id,requested_action,baseline_event_seq from run_recovery_operations where run_id=?1",
                [run_id],
                |row| {
                    Ok(PendingRunRecovery {
                        run_id: row.get(0)?,
                        requested_action: row.get(1)?,
                        baseline_event_seq: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn activate_pending_run_recovery(&self, run_id: &str) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (agent_id, submission_state): (String, String) = tx.query_row("select agent_id,submission_state from workbench_runs where run_id=?1 and exists(select 1 from run_recovery_operations where run_id=?1)", [run_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "Pending run recovery is not known.".to_string())?;
        if matches!(submission_state.as_str(), "terminal" | "submission_failed") {
            assert_agent_capacity(&tx, &agent_id)?;
        }
        let changed = tx.execute(
                "update workbench_runs set cached_status='recovering',submission_state='submitted',cancel_requested=0,interrupt_pending=0,updated_at=?2 where run_id=?1 and exists(select 1 from run_recovery_operations where run_id=?1)",
                params![run_id, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Pending run recovery is not known.".into());
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clear_run_recovery_operation(&self, run_id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "delete from run_recovery_operations where run_id=?1",
                [run_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn finalize_recovered_run(
        &self,
        run_id: &str,
        result: &serde_json::Value,
        cached_status: &str,
        submission_state: &str,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let changed = tx
            .execute(
                "update workbench_runs set result_json=?2,cached_status=?3,submission_state=?4,interrupt_pending=0,updated_at=?5 where run_id=?1",
                params![run_id, result.to_string(), cached_status, submission_state, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Run is not known.".into());
        }
        tx.execute(
            "delete from run_recovery_operations where run_id=?1",
            [run_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
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

    #[cfg(test)]
    pub fn set_cancel_requested_for_agent(
        &self,
        agent_id: &str,
        run_id: &str,
    ) -> Result<(), String> {
        self.assert_run_owner(agent_id, run_id)?;
        self.set_cancel_requested(run_id)
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
        let mut statement = connection.prepare("select i.id,r.run_id,i.title,i.created_at,i.session_id,r.agent_id,i.pinned_agent_name,r.agent_fingerprint,r.agent_config_path,r.invocation_kind,r.cached_status,r.submission_state,r.cancel_requested,r.interrupt_pending,r.workspace_root,r.shell_cwd from workbench_runs r join workbench_items i on i.id=r.item_id order by r.created_at,r.run_id").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok(Reservation {
                    item_id: r.get(0)?,
                    run_id: r.get(1)?,
                    title: r.get(2)?,
                    created_at: r.get(3)?,
                    session_id: r.get(4)?,
                    agent_id: r.get(5)?,
                    agent_name: r.get(6)?,
                    agent_fingerprint: r.get(7)?,
                    agent_config_path: r.get(8)?,
                    invocation_kind: r.get(9)?,
                    cached_status: r.get(10)?,
                    submission_state: r.get(11)?,
                    cancel_requested: r.get(12)?,
                    interrupt_pending: r.get(13)?,
                    workspace_root: r.get(14)?,
                    shell_cwd: r.get(15)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn load_runs_for_agent(&self, agent_id: &str) -> Result<Vec<Reservation>, String> {
        Ok(self
            .load_runs()?
            .into_iter()
            .filter(|run| run.agent_id == agent_id)
            .collect())
    }

    pub fn load_run_for_agent(&self, agent_id: &str, run_id: &str) -> Result<Reservation, String> {
        self.load_runs_for_agent(agent_id)?
            .into_iter()
            .find(|run| run.run_id == run_id)
            .ok_or_else(|| "Run was not found for this agent.".into())
    }

    pub fn load_setting(&self, key: &str) -> Result<Option<Value>, String> {
        let connection = self.connection.lock().unwrap();
        let value = connection
            .query_row(
                "select value_json from desktop_settings where key=?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        value
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn save_setting(&self, key: &str, value: &Value) -> Result<(), String> {
        let value = serde_json::to_string(value).map_err(|error| error.to_string())?;
        self.connection
            .lock()
            .unwrap()
            .execute(
                "insert into desktop_settings(key,value_json) values(?1,?2) on conflict(key) do update set value_json=excluded.value_json",
                params![key, value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn save_pending_approval(&self, value: &PendingApproval) -> Result<(), String> {
        self.connection.lock().unwrap().execute("insert into pending_approvals(root_run_id,approval_run_id,approval_id,parent_run_id,tool_name,message,decision_in_flight,decision,operation_state,updated_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) on conflict(root_run_id) do update set approval_run_id=excluded.approval_run_id,approval_id=excluded.approval_id,parent_run_id=excluded.parent_run_id,tool_name=excluded.tool_name,message=excluded.message,decision_in_flight=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.decision_in_flight else excluded.decision_in_flight end,decision=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.decision else excluded.decision end,operation_state=case when pending_approvals.approval_id=excluded.approval_id then pending_approvals.operation_state else excluded.operation_state end,updated_at=excluded.updated_at", params![value.root_run_id,value.approval_run_id,value.approval_id,value.parent_run_id,value.tool_name,value.message,value.decision_in_flight,value.decision,value.operation_state,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
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

    #[cfg(test)]
    pub fn load_pending_approvals_for_agent(
        &self,
        agent_id: &str,
    ) -> Result<Vec<PendingApproval>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement=connection.prepare("select p.root_run_id,p.approval_run_id,p.approval_id,p.parent_run_id,p.tool_name,p.message,p.decision_in_flight,p.decision,p.operation_state from pending_approvals p join workbench_runs r on r.run_id=p.root_run_id where r.agent_id=?1 order by p.root_run_id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([agent_id], |r| {
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

    pub fn load_pending_approvals_for_generation(
        &self,
        agent_id: &str,
        config_path: &str,
        fingerprint: &str,
    ) -> Result<Vec<PendingApproval>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement=connection.prepare("select p.root_run_id,p.approval_run_id,p.approval_id,p.parent_run_id,p.tool_name,p.message,p.decision_in_flight,p.decision,p.operation_state from pending_approvals p join workbench_runs r on r.run_id=p.root_run_id where r.agent_id=?1 and r.agent_config_path=?2 and r.agent_fingerprint=?3 order by p.root_run_id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(params![agent_id, config_path, fingerprint], |r| {
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

    pub fn item_is_occupied(&self, agent_id: &str, item_id: &str) -> Result<bool, String> {
        self.connection.lock().unwrap().query_row("select exists(select 1 from workbench_runs where agent_id=?1 and item_id=?2 and submission_state not in ('terminal','submission_failed'))", params![agent_id,item_id], |row| row.get(0)).map_err(|e|e.to_string())
    }

    pub fn assert_pending_approval_owner(
        &self,
        agent_id: &str,
        root_run_id: &str,
        approval_run_id: &str,
        approval_id: &str,
    ) -> Result<(), String> {
        let owned: bool = self.connection.lock().unwrap().query_row(
            "select exists(select 1 from pending_approvals p join workbench_runs r on r.run_id=p.root_run_id where r.agent_id=?1 and p.root_run_id=?2 and p.approval_run_id=?3 and p.approval_id=?4)",
            params![agent_id,root_run_id,approval_run_id,approval_id], |r| r.get(0)).map_err(|e|e.to_string())?;
        if owned {
            Ok(())
        } else {
            Err("Pending approval was not found for this agent.".into())
        }
    }

    pub fn active_agent_ids(&self) -> Result<Vec<String>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement=connection.prepare("select distinct agent_id from (select agent_id from workbench_runs where agent_id is not null and submission_state not in ('terminal','submission_failed') union select r.agent_id from pending_approvals p join workbench_runs r on r.run_id=p.root_run_id union select r.agent_id from run_recovery_operations o join workbench_runs r on r.run_id=o.run_id union select agent_id from deletion_jobs where state='pending' and agent_id is not null) order by agent_id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get(0))
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
                attachments: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut messages = messages;
    for message in &mut messages {
        message.attachments = load_message_attachments(connection, &message.id)?;
    }
    Ok(messages)
}

fn load_message_attachments(
    connection: &Connection,
    message_id: &str,
) -> Result<Vec<AttachmentDraft>, String> {
    let mut statement=connection.prepare("select a.attachment_id,a.display_name,a.kind,a.size_bytes,a.mime_type,a.staged_relative_path,a.sha256,a.audio_format from message_attachments m join attachments a on a.attachment_id=m.attachment_id where m.message_id=?1 order by m.ordinal").map_err(|e|e.to_string())?;
    let attachments = statement
        .query_map([message_id], |r| {
            Ok(AttachmentDraft {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                size_bytes: r.get(3)?,
                mime_type: r.get(4)?,
                staged_relative_path: r.get(5)?,
                sha256: r.get(6)?,
                audio_format: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(attachments)
}

fn claim_attachments(
    tx: &rusqlite::Transaction<'_>,
    ids: &[String],
    agent_id: &str,
    join_table: &str,
    owner_column: &str,
    owner: &str,
) -> Result<(), String> {
    for (ordinal, id) in ids.iter().enumerate() {
        let changed=tx.execute("update attachments set state='owned',claimed_at=?2,owner_agent_id=?3 where attachment_id=?1 and state='draft' and (owner_agent_id=?3 or owner_agent_id is null)",params![id,now(),agent_id]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("ATTACHMENT_NOT_FOUND: Draft was already claimed or discarded.".into());
        }
        let sql = format!(
            "insert into {join_table}({owner_column},attachment_id,ordinal) values(?1,?2,?3)"
        );
        tx.execute(&sql, params![owner, id, ordinal as i64])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn now() -> String {
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
            created_at: "100".into(),
            session_id: None,
            agent_id: "agent".into(),
            agent_name: "Agent".into(),
            agent_fingerprint: "fp".into(),
            agent_config_path: Some("/agents/agent.json".into()),
            invocation_kind: "run".into(),
            cached_status: "reserved".into(),
            submission_state: "reserved".into(),
            cancel_requested: false,
            interrupt_pending: false,
            workspace_root: Some("/workspace".into()),
            shell_cwd: Some("/workspace/project".into()),
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
    fn migration_backfills_run_agent_ownership_and_resolved_config_path() {
        let source = tempfile::NamedTempFile::new().unwrap();
        {
            let connection = Connection::open(source.path()).unwrap();
            connection.execute_batch("create table desktop_migrations(version integer primary key, applied_at text not null);").unwrap();
            for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version < 10) {
                connection.execute_batch(sql).unwrap();
                connection
                    .execute("insert into desktop_migrations values(?1,'now')", [version])
                    .unwrap();
            }
            connection.execute("insert into workbench_items(id,kind,title,session_id,pinned_agent_id,pinned_agent_name,pinned_agent_fingerprint,created_at,updated_at) values('legacy-item','task','Legacy task',null,'legacy-agent','Legacy Agent','legacy-fingerprint','100','100')", []).unwrap();
            connection.execute("insert into workbench_runs(run_id,item_id,invocation_kind,cached_status,submission_state,created_at,updated_at) values('legacy-run','legacy-item','run','succeeded','terminal','100','100')", []).unwrap();
        }

        let migrated = tempfile::NamedTempFile::new().unwrap();
        std::fs::copy(source.path(), migrated.path()).unwrap();
        let db = WorkbenchDb::open(migrated.path()).unwrap();
        let legacy = &db.load_runs().unwrap()[0];
        assert_eq!(legacy.agent_id, "legacy-agent");
        assert_eq!(legacy.agent_fingerprint, "legacy-fingerprint");
        assert_eq!(legacy.agent_config_path, None);

        db.backfill_agent_config_path(
            "legacy-agent",
            "legacy-fingerprint",
            "/agents/legacy-agent.json",
        )
        .unwrap();
        assert_eq!(
            db.load_runs().unwrap()[0].agent_config_path.as_deref(),
            Some("/agents/legacy-agent.json")
        );
        let source_connection = Connection::open(source.path()).unwrap();
        assert_eq!(
            source_connection
                .query_row("select max(version) from desktop_migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            9
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

    #[test]
    fn reservations_enforce_agent_capacity_across_fingerprints() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        for index in 0..3 {
            let mut run = reservation();
            run.item_id = format!("item-{index}");
            run.run_id = format!("run-{index}");
            run.agent_fingerprint = format!("fingerprint-{index}");
            db.reserve_task(&run).unwrap();
        }
        let mut fourth = reservation();
        fourth.item_id = "item-4".into();
        fourth.run_id = "run-4".into();
        fourth.agent_fingerprint = "newest-fingerprint".into();
        assert!(db
            .reserve_task(&fourth)
            .unwrap_err()
            .contains("3 task slots"));
        assert_eq!(db.load_runs_for_agent("agent").unwrap().len(), 3);
    }

    #[test]
    fn reservations_isolate_capacity_between_agents() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        for index in 0..3 {
            let mut run = reservation();
            run.item_id = format!("agent-item-{index}");
            run.run_id = format!("agent-run-{index}");
            db.reserve_task(&run).unwrap();
        }
        let mut other = reservation();
        other.item_id = "other-item".into();
        other.run_id = "other-run".into();
        other.agent_id = "other".into();
        db.reserve_task(&other).unwrap();
        assert_eq!(db.load_runs_for_agent("agent").unwrap().len(), 3);
        assert_eq!(db.load_runs_for_agent("other").unwrap().len(), 1);
    }

    #[test]
    fn chat_turn_reservation_shares_agent_capacity_with_tasks() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.create_chat(&ChatItem {
            item_id: "capacity-chat".into(),
            title: "chat".into(),
            created_at: "now".into(),
            session_id: "capacity-session".into(),
            pinned_agent_id: "agent".into(),
            pinned_agent_name: "Agent".into(),
            pinned_agent_fingerprint: "new-fingerprint".into(),
            pinned_agent_config_path: Some("/agent.json".into()),
            workspace_root: Some("/workspace".into()),
            shell_cwd: Some("/workspace".into()),
        })
        .unwrap();
        for index in 0..3 {
            let mut run = reservation();
            run.item_id = format!("capacity-item-{index}");
            run.run_id = format!("capacity-run-{index}");
            db.reserve_task(&run).unwrap();
        }
        assert!(db
            .reserve_chat_turn("capacity-chat", "chat-run", "hello")
            .unwrap_err()
            .contains("3 task slots"));
    }

    #[test]
    fn same_run_recovery_is_an_atomic_terminal_to_submitted_transition() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        assert!(db.begin_same_run_recovery("run", "resume", 4).is_err());
        db.update_run("run", "interrupted", "terminal").unwrap();
        db.set_cancel_requested("run").unwrap();
        db.set_interrupt_pending("run", true).unwrap();
        db.store_result("run", &serde_json::json!({"status":"failure"}))
            .unwrap();
        db.begin_same_run_recovery("run", "resume", 4).unwrap();
        let recovered = &db.load_runs().unwrap()[0];
        assert_eq!(recovered.cached_status, "recovering");
        assert_eq!(recovered.submission_state, "submitted");
        assert!(!recovered.cancel_requested);
        assert!(!recovered.interrupt_pending);
        assert_eq!(
            db.get_result("run").unwrap(),
            Some(serde_json::json!({"status":"failure"}))
        );
        assert_eq!(
            db.load_run_recovery_operations().unwrap(),
            vec![PendingRunRecovery {
                run_id: "run".into(),
                requested_action: "resume".into(),
                baseline_event_seq: 4,
            }]
        );
        assert!(db.begin_same_run_recovery("run", "resume", 4).is_err());
        db.finalize_recovered_run(
            "run",
            &serde_json::json!({"status":"success","output":"done"}),
            "succeeded",
            "terminal",
        )
        .unwrap();
        assert!(db.load_run_recovery_operations().unwrap().is_empty());
        assert_eq!(db.load_runs().unwrap()[0].cached_status, "succeeded");
        assert_eq!(
            db.get_result("run").unwrap(),
            Some(serde_json::json!({"status":"success","output":"done"}))
        );
    }

    #[test]
    fn activating_already_nonterminal_recovery_does_not_count_itself_twice() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        db.update_run("run", "interrupted", "terminal").unwrap();
        db.begin_same_run_recovery("run", "resume", 4).unwrap();
        for index in 1..3 {
            let mut other = reservation();
            other.item_id = format!("other-item-{index}");
            other.run_id = format!("other-run-{index}");
            db.reserve_task(&other).unwrap();
        }
        assert_eq!(db.load_runs_for_agent("agent").unwrap().len(), 3);
        db.activate_pending_run_recovery("run").unwrap();
        assert_eq!(
            db.load_run_for_agent("agent", "run")
                .unwrap()
                .submission_state,
            "submitted"
        );
    }

    fn chat() -> ChatItem {
        ChatItem {
            item_id: "chat".into(),
            title: "Chat".into(),
            created_at: "100".into(),
            session_id: "session-stable".into(),
            pinned_agent_id: "agent".into(),
            pinned_agent_name: "Agent".into(),
            pinned_agent_fingerprint: "fingerprint".into(),
            pinned_agent_config_path: Some("/agents/agent.json".into()),
            workspace_root: Some("/workspace".into()),
            shell_cwd: Some("/workspace".into()),
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
    fn chat_attachment_claim_is_atomic_and_replays_owned_descriptors() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.create_chat(&chat()).unwrap();
        let draft = AttachmentDraft {
            id: "attachment".into(),
            name: "notes.txt".into(),
            kind: "file".into(),
            size_bytes: 5,
            mime_type: Some("text/plain".into()),
            staged_relative_path: "attachment/notes.txt".into(),
            sha256: "a".repeat(64),
            audio_format: None,
        };
        db.insert_draft(&draft).unwrap();
        let messages = db
            .reserve_chat_turn_with_attachments(
                "chat",
                "run-with-attachment",
                "read this",
                &[draft.id.clone()],
            )
            .unwrap();
        assert_eq!(messages[0].attachments, vec![draft.clone()]);
        assert_eq!(db.load_chat("chat").unwrap().1[0].attachments, vec![draft]);
        assert!(db.discard_draft("attachment").unwrap().is_none());

        let second = AttachmentDraft {
            id: "second".into(),
            name: "second.txt".into(),
            kind: "file".into(),
            size_bytes: 1,
            mime_type: None,
            staged_relative_path: "second/second.txt".into(),
            sha256: "b".repeat(64),
            audio_format: None,
        };
        db.insert_draft(&second).unwrap();
        assert!(db
            .reserve_chat_turn_with_attachments(
                "chat",
                "overlap",
                "must roll back",
                &[second.id.clone()],
            )
            .is_err());
        assert_eq!(db.get_drafts(&[second.id]).unwrap().len(), 1);
        assert!(db.attachment_cleanup_candidates().unwrap().is_empty());
        assert!(db.discard_draft("second").unwrap().is_some());
        assert_eq!(
            db.attachment_cleanup_candidates().unwrap(),
            vec![("second".into(), "second/second.txt".into())]
        );
        db.finish_attachment_cleanup("second").unwrap();
        assert!(db.attachment_cleanup_candidates().unwrap().is_empty());
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

    #[test]
    fn desktop_settings_round_trip_structured_privacy_values() {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let db = WorkbenchDb::open(file.path()).unwrap();
            db.save_setting(
                "trace_privacy",
                &serde_json::json!({"messages":true,"reasoning":false,"rawToolPayloads":true}),
            )
            .unwrap();
        }
        let db = WorkbenchDb::open(file.path()).unwrap();
        assert_eq!(
            db.load_setting("trace_privacy").unwrap(),
            Some(serde_json::json!({"messages":true,"reasoning":false,"rawToolPayloads":true}))
        );
        assert_eq!(db.load_setting("missing").unwrap(), None);
    }

    #[test]
    fn deletion_operations_cover_task_attempts_and_chat_context_suffixes() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        db.connection.lock().unwrap().execute("insert into workbench_runs(run_id,item_id,invocation_kind,cached_status,submission_state,created_at,updated_at) values('retry','item','run','failed','terminal','later','later')",[]).unwrap();
        let task = db.item_deletion_operation("item").unwrap();
        assert_eq!(
            task["runtimeTargets"],
            serde_json::json!([
                {"kind":"root-run","rootRunId":"run"},
                {"kind":"root-run","rootRunId":"retry"}
            ])
        );

        db.create_chat(&chat()).unwrap();
        db.reserve_chat_turn("chat", "chat-run-1", "one").unwrap();
        db.finalize_chat_success("chat-run-1", &serde_json::json!("one"), "answer one")
            .unwrap();
        db.reserve_chat_turn("chat", "chat-run-2", "two").unwrap();
        db.finalize_chat_success("chat-run-2", &serde_json::json!("two"), "answer two")
            .unwrap();
        let operation = db.chat_turn_deletion_operation("chat", 2).unwrap();
        assert_eq!(
            operation["runtimeTargets"],
            serde_json::json!([{"kind":"root-run","rootRunId":"chat-run-2"}])
        );
        assert_eq!(
            db.item_deletion_operation("chat").unwrap()["workbenchRunIds"],
            serde_json::json!(["chat-run-2", "chat-run-1"])
        );
        let job = db.create_deletion_job(&operation).unwrap();
        db.complete_deletion_job(&job).unwrap();
        assert_eq!(
            db.load_chat("chat")
                .unwrap()
                .1
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "answer one"]
        );
        assert!(db.run_deletion_operation("chat-run-1").is_err());
    }

    #[test]
    fn deletion_tombstone_survives_atomic_local_failure_and_retry_is_idempotent() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        let operation = db.item_deletion_operation("item").unwrap();
        let job = db.create_deletion_job(&operation).unwrap();
        db.connection.lock().unwrap().execute_batch("create trigger fail_local_deletion before delete on workbench_items begin select raise(abort, 'injected local failure'); end;").unwrap();
        assert!(db.complete_deletion_job(&job).is_err());
        assert_eq!(db.load_deletion_jobs().unwrap(), vec![job.clone()]);
        assert_eq!(db.load_runs().unwrap().len(), 1);
        db.connection
            .lock()
            .unwrap()
            .execute_batch("drop trigger fail_local_deletion;")
            .unwrap();
        db.complete_deletion_job(&job).unwrap();
        assert!(db.load_deletion_jobs().unwrap().is_empty());
        assert!(db.load_runs().unwrap().is_empty());
        assert!(db.complete_deletion_job(&job).is_ok());
    }

    #[test]
    fn catalog_reconciliation_is_all_agent_exact_and_never_overwrites() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        let mut active = reservation();
        active.agent_config_path = None;
        db.reserve_task(&active).unwrap();
        let mut archived = reservation();
        archived.item_id = "archived-item".into();
        archived.run_id = "archived-run".into();
        archived.agent_id = "archived".into();
        archived.agent_fingerprint = "old-fingerprint".into();
        archived.agent_config_path = None;
        db.reserve_task(&archived).unwrap();
        let mut fixed = reservation();
        fixed.item_id = "fixed-item".into();
        fixed.run_id = "fixed-run".into();
        fixed.agent_config_path = Some("keep.json".into());
        db.reserve_task(&fixed).unwrap();

        db.reconcile_agent_catalog(&[
            AgentCatalogMapping {
                agent_id: "agent".into(),
                fingerprint: "fp".into(),
                config_path: "active.json".into(),
            },
            AgentCatalogMapping {
                agent_id: "archived".into(),
                fingerprint: "old-fingerprint".into(),
                config_path: "archive.json".into(),
            },
            // Duplicate input is harmless; production callers deduplicate catalog triples.
            AgentCatalogMapping {
                agent_id: "agent".into(),
                fingerprint: "fp".into(),
                config_path: "active.json".into(),
            },
            AgentCatalogMapping {
                agent_id: "archived".into(),
                fingerprint: "changed".into(),
                config_path: "wrong.json".into(),
            },
        ])
        .unwrap();
        let runs = db.load_runs().unwrap();
        assert_eq!(
            runs.iter()
                .find(|r| r.run_id == "run")
                .unwrap()
                .agent_config_path
                .as_deref(),
            Some("active.json")
        );
        assert_eq!(
            runs.iter()
                .find(|r| r.run_id == "archived-run")
                .unwrap()
                .agent_config_path
                .as_deref(),
            Some("archive.json")
        );
        assert_eq!(
            runs.iter()
                .find(|r| r.run_id == "fixed-run")
                .unwrap()
                .agent_config_path
                .as_deref(),
            Some("keep.json")
        );
    }

    #[test]
    fn catalog_removal_and_restore_preserve_agent_history_and_results() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        db.update_run("run", "succeeded", "terminal").unwrap();
        db.store_result("run", &serde_json::json!({"artifact":"report.md"}))
            .unwrap();

        db.reconcile_agent_catalog(&[]).unwrap();
        assert_eq!(db.load_runs_for_agent("agent").unwrap().len(), 1);
        assert_eq!(
            db.get_result("run").unwrap(),
            Some(serde_json::json!({"artifact":"report.md"}))
        );

        db.reconcile_agent_catalog(&[AgentCatalogMapping {
            agent_id: "agent".into(),
            fingerprint: "fingerprint".into(),
            config_path: "/agents/agent.json".into(),
        }])
        .unwrap();
        let restored = db.load_run_for_agent("agent", "run").unwrap();
        assert_eq!(
            restored.agent_config_path.as_deref(),
            Some("/agents/agent.json")
        );
        assert_eq!(restored.cached_status, "succeeded");
    }

    #[test]
    fn orphaned_generation_is_interrupted_without_touching_valid_or_historical_results() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        let valid = reservation();
        db.reserve_task(&valid).unwrap();
        let mut orphan = reservation();
        orphan.item_id = "orphan-item".into();
        orphan.run_id = "orphan-run".into();
        orphan.agent_fingerprint = "gone".into();
        db.reserve_task(&orphan).unwrap();
        db.store_result("orphan-run", &serde_json::json!({"partial":"kept"}))
            .unwrap();
        db.connection
            .lock()
            .unwrap()
            .execute(
                "insert into run_recovery_operations values('orphan-run','resume',1,'now')",
                [],
            )
            .unwrap();

        assert_eq!(
            db.interrupt_orphaned_generations(&[AgentCatalogMapping {
                agent_id: "agent".into(),
                fingerprint: "fp".into(),
                config_path: "/agents/agent.json".into()
            }])
            .unwrap(),
            vec!["orphan-run"]
        );
        assert_eq!(
            db.load_run_for_agent("agent", "run")
                .unwrap()
                .submission_state,
            "reserved"
        );
        let orphan = db.load_run_for_agent("agent", "orphan-run").unwrap();
        assert_eq!(
            (
                orphan.cached_status.as_str(),
                orphan.submission_state.as_str()
            ),
            ("interrupted", "terminal")
        );
        assert_eq!(
            db.get_result("orphan-run").unwrap(),
            Some(serde_json::json!({"partial":"kept"}))
        );
        assert!(db.load_run_recovery_operations().unwrap().is_empty());
    }

    #[test]
    fn agent_scoped_history_and_attachment_control_rejects_other_agent() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        let mut other = reservation();
        other.item_id = "other-item".into();
        other.run_id = "other-run".into();
        other.agent_id = "other".into();
        db.reserve_task(&other).unwrap();
        assert_eq!(db.load_runs_for_agent("agent").unwrap().len(), 1);
        assert!(db.assert_run_owner("agent", "other-run").is_err());
        assert!(db
            .set_cancel_requested_for_agent("agent", "other-run")
            .is_err());
        assert!(db.delete_item_for_agent("agent", "other-item").is_err());

        let draft = AttachmentDraft {
            id: "draft".into(),
            name: "x".into(),
            kind: "file".into(),
            size_bytes: 1,
            mime_type: None,
            staged_relative_path: "draft/x".into(),
            sha256: "hash".into(),
            audio_format: None,
        };
        db.insert_draft_for_agent("other", &draft).unwrap();
        assert!(db.get_drafts_for_agent("agent", &["draft".into()]).is_err());
        assert_eq!(db.discard_draft_for_agent("agent", "draft").unwrap(), None);
        assert!(db
            .reserve_task_with_attachments(&reservation(), &["draft".into()])
            .is_err());
    }

    #[test]
    fn delegated_pending_approval_is_owned_by_root_agent() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        db.save_pending_approval(&PendingApproval {
            root_run_id: "run".into(),
            approval_run_id: "delegated-child".into(),
            approval_id: "approval".into(),
            parent_run_id: Some("run".into()),
            tool_name: "tool".into(),
            message: "approve".into(),
            decision_in_flight: false,
            decision: None,
            operation_state: "awaiting_decision".into(),
        })
        .unwrap();
        assert_eq!(
            db.load_pending_approvals_for_agent("agent").unwrap().len(),
            1
        );
        assert!(db
            .assert_pending_approval_owner("agent", "run", "delegated-child", "approval")
            .is_ok());
        assert!(db
            .assert_pending_approval_owner("other", "run", "delegated-child", "approval")
            .is_err());
    }

    #[test]
    fn active_agent_ids_include_every_durable_work_source() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        assert_eq!(db.active_agent_ids().unwrap(), vec!["agent"]);
        db.update_run("run", "succeeded", "terminal").unwrap();
        assert!(db.active_agent_ids().unwrap().is_empty());
        db.save_pending_approval(&PendingApproval {
            root_run_id: "run".into(),
            approval_run_id: "child".into(),
            approval_id: "approval".into(),
            parent_run_id: None,
            tool_name: "tool".into(),
            message: "approve".into(),
            decision_in_flight: false,
            decision: None,
            operation_state: "awaiting_decision".into(),
        })
        .unwrap();
        assert_eq!(db.active_agent_ids().unwrap(), vec!["agent"]);
    }

    #[test]
    fn submission_failed_run_alone_does_not_activate_agent() {
        let db = WorkbenchDb::open_in_memory().unwrap();
        db.reserve_task(&reservation()).unwrap();
        db.update_run("run", "failed", "submission_failed").unwrap();
        assert!(db.active_agent_ids().unwrap().is_empty());
    }
}
