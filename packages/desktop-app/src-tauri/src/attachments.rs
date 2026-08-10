use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_SUBMISSION_BYTES: u64 = 40 * 1024 * 1024;
pub const MAX_ATTACHMENT_COUNT: usize = 8;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDraft {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing)]
    pub staged_relative_path: String,
    #[serde(skip_serializing)]
    pub sha256: String,
    #[serde(skip_serializing)]
    pub audio_format: Option<String>,
}

fn safe_name(path: &Path) -> String {
    path.file_name()
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .unwrap_or("attachment")
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect()
}

pub fn import_file(root: &Path, source: &Path) -> Result<AttachmentDraft, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|_| "ATTACHMENT_NOT_FOUND: Selected file is unavailable.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(
            "ATTACHMENT_PATH_INVALID: Only regular, non-symbolic-link files can be attached."
                .into(),
        );
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("ATTACHMENT_TOO_LARGE: File exceeds 10 MiB.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = safe_name(source);
    let directory = root.join(&id);
    fs::create_dir_all(&directory).map_err(|e| format!("ATTACHMENTS_UNAVAILABLE: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let destination = directory.join(&name);
    let result = (|| {
        let mut input_options = OpenOptions::new();
        input_options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            input_options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut input = input_options.open(source).map_err(|e| e.to_string())?;
        let opened_metadata = input.metadata().map_err(|e| e.to_string())?;
        if !opened_metadata.is_file() {
            return Err("ATTACHMENT_PATH_INVALID: Selected path is not a regular file.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino() {
                return Err("ATTACHMENT_CHANGED: Selected file changed during import.".into());
            }
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut prefix = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > MAX_FILE_BYTES {
                return Err("ATTACHMENT_TOO_LARGE: File exceeds 10 MiB.".into());
            }
            if prefix.len() < 8192 {
                prefix.extend_from_slice(&buffer[..n.min(8192 - prefix.len())]);
            }
            hash.update(&buffer[..n]);
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        output.sync_all().map_err(|e| e.to_string())?;
        let mime = infer::get(&prefix).map(|v| v.mime_type().to_string());
        let kind = match mime.as_deref() {
            Some(v) if v.starts_with("image/") => "image",
            Some(v) if v.starts_with("audio/") => "audio",
            _ => "file",
        }
        .to_string();
        let audio_format = mime
            .as_deref()
            .and_then(|m| match m {
                "audio/wav" | "audio/x-wav" => Some("wav"),
                "audio/mpeg" => Some("mp3"),
                "audio/flac" => Some("flac"),
                "audio/mp4" => Some("m4a"),
                "audio/ogg" => Some("ogg"),
                "audio/aac" => Some("aac"),
                "audio/aiff" => Some("aiff"),
                _ => None,
            })
            .map(str::to_string);
        Ok(AttachmentDraft {
            id: id.clone(),
            name,
            kind,
            size_bytes: size,
            mime_type: mime,
            staged_relative_path: format!(
                "{id}/{}",
                destination.file_name().unwrap().to_string_lossy()
            ),
            sha256: format!("{:x}", hash.finalize()),
            audio_format,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result
}

pub fn validate_staged(root: &Path, draft: &AttachmentDraft) -> Result<PathBuf, String> {
    let relative = Path::new(&draft.staged_relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("ATTACHMENT_PATH_INVALID".into());
    }
    let path = root.join(relative);
    let meta = fs::symlink_metadata(&path).map_err(|_| "ATTACHMENT_NOT_FOUND".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() != draft.size_bytes {
        return Err("ATTACHMENT_CHANGED".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "ATTACHMENT_NOT_FOUND".to_string())?;
    if !file
        .metadata()
        .map_err(|_| "ATTACHMENT_NOT_FOUND".to_string())?
        .is_file()
    {
        return Err("ATTACHMENT_CHANGED".into());
    }
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|e| e.to_string())?;
    if format!("{:x}", hash.finalize()) != draft.sha256 {
        return Err("ATTACHMENT_CHANGED".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_snapshot_and_rejects_symlink() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("managed");
        let src = t.path().join("x.png");
        fs::write(&src, b"not really png").unwrap();
        let d = import_file(&root, &src).unwrap();
        assert_eq!(d.kind, "file");
        let renderer_value = serde_json::to_value(&d).unwrap();
        assert!(renderer_value.get("stagedRelativePath").is_none());
        assert!(renderer_value.get("sha256").is_none());
        assert!(renderer_value.get("audioFormat").is_none());
        fs::write(&src, b"changed").unwrap();
        assert_eq!(
            fs::read(validate_staged(&root, &d).unwrap()).unwrap(),
            b"not really png"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&src, t.path().join("link")).unwrap();
            assert!(import_file(&root, &t.path().join("link")).is_err())
        }
    }
}
