use crate::windows_paths::{directories, identity, rename_new};
use std::path::{Path, PathBuf};

const TARGET: &str = "manage-codexboard";
const PREFIX: &str = ".manage-codexboard.install-";
fn destination(
    home: &Path,
    staging: &str,
) -> Result<(Vec<std::fs::File>, PathBuf, PathBuf), String> {
    if !staging.starts_with(PREFIX)
        || staging.len() == PREFIX.len()
        || staging.contains(['/', '\\', ':', '\0'])
        || staging.ends_with(['.', ' '])
    {
        return Err("Skill 暂存目录名称无效".into());
    }
    let parent = home.join(".agents/skills");
    let handles = directories(&parent)?;
    Ok((handles, parent.join(TARGET), parent.join(staging)))
}
pub fn atomic_install(
    home: &Path,
    staging: &str,
    expected: Option<(u64, u64)>,
) -> Result<(), String> {
    let (_handles, target, stage) = destination(home, staging)?;
    // Windows has no atomic directory-exchange primitive. Preserve an existing
    // skill rather than emulate exchange with two crash-unsafe moves.
    if expected.is_some() {
        return Err("Windows 暂不支持原子替换已有 Skill，原目录已保留".into());
    }
    if identity(&stage)?.is_none() || identity(&target)?.is_some() {
        return Err("Skill 目录已变化，未提交安装".into());
    }
    rename_new(&stage, &target)
}
pub fn rollback_new_install(
    home: &Path,
    staging: &str,
    expected: (u64, u64),
) -> Result<(), String> {
    let (_handles, target, stage) = destination(home, staging)?;
    if identity(&target)? != Some(expected) || identity(&stage)?.is_some() {
        return Err("Skill 目录已变化，未回退安装".into());
    }
    rename_new(&target, &stage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn first_install_and_rollback_preserve_identity_and_never_replace_existing_skill() {
        let home = std::env::temp_dir().join(format!(
            "codexboard-win-skill-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let parent = home.join(".agents/skills");
        let stage = parent.join(format!("{PREFIX}test"));
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("keep"), "new").unwrap();
        let id = identity(&stage).unwrap().unwrap();
        atomic_install(&home, &format!("{PREFIX}test"), None).unwrap();
        assert_eq!(identity(&parent.join(TARGET)).unwrap(), Some(id));
        rollback_new_install(&home, &format!("{PREFIX}test"), id).unwrap();
        fs::create_dir(parent.join(TARGET)).unwrap();
        fs::write(parent.join(TARGET).join("keep"), "old").unwrap();
        assert!(atomic_install(&home, &format!("{PREFIX}test"), None).is_err());
        assert!(atomic_install(
            &home,
            &format!("{PREFIX}test"),
            identity(&parent.join(TARGET)).unwrap()
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(parent.join(TARGET).join("keep")).unwrap(),
            "old"
        );
        assert_eq!(fs::read_to_string(stage.join("keep")).unwrap(), "new");
        fs::remove_dir_all(home).unwrap();
    }
}
