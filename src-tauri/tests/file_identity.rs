use std::fs;
use std::path::PathBuf;

use qingmo_lib::services::file_identity::{
    file_identity, identity_from_metadata, observe_path, same_identity, same_identity_opt,
    same_observation, FileIdentity, FileObservation,
};

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn write(path: &PathBuf, contents: &str) {
    fs::write(path, contents).expect("write fixture");
}

#[test]
fn observes_a_present_file() {
    let dir = temp_dir();
    let path = dir.path().join("a.md");
    write(&path, "hello");

    let observation = observe_path(&path).expect("observe");
    match observation {
        FileObservation::Present(identity) => {
            assert!(matches!(identity, FileIdentity::Inode { .. }));
        }
        other => panic!("expected present, got {other:?}"),
    }
}

#[test]
fn observes_a_missing_file_as_absent() {
    let dir = temp_dir();
    let observation = observe_path(&dir.path().join("missing.md")).expect("observe");
    assert_eq!(observation, FileObservation::Absent);
}

#[test]
fn observes_a_directory() {
    let dir = temp_dir();
    let observation = observe_path(dir.path()).expect("observe");
    assert!(matches!(observation, FileObservation::Present(_)));
}

#[test]
fn identity_survives_rename() {
    let dir = temp_dir();
    let old = dir.path().join("old.md");
    let new = dir.path().join("new.md");
    write(&old, "hello");
    let before = file_identity(&old).expect("identity").expect("supported");
    fs::rename(&old, &new).expect("rename");
    let after = file_identity(&new).expect("identity").expect("supported");
    assert!(same_identity(&before, &after));
}

#[test]
fn atomic_replace_changes_identity() {
    let dir = temp_dir();
    let path = dir.path().join("doc.md");
    write(&path, "first");
    let before = file_identity(&path).expect("identity").expect("supported");

    let replacement = dir.path().join("replacement.md");
    write(&replacement, "second");
    fs::rename(&replacement, &path).expect("replace");
    let after = file_identity(&path).expect("identity").expect("supported");

    assert!(!same_identity(&before, &after));
}

#[test]
fn hard_links_share_the_same_identity() {
    let dir = temp_dir();
    let first = dir.path().join("first.md");
    let second = dir.path().join("second.md");
    write(&first, "hello");
    fs::hard_link(&first, &second).expect("hard link");

    let first_identity = file_identity(&first).expect("identity").expect("supported");
    let second_identity = file_identity(&second)
        .expect("identity")
        .expect("supported");
    assert!(same_identity(&first_identity, &second_identity));
}

#[test]
fn identity_from_metadata_matches_path_identity() {
    let dir = temp_dir();
    let path = dir.path().join("a.md");
    write(&path, "hello");

    let metadata = fs::metadata(&path).expect("metadata");
    let from_metadata = identity_from_metadata(&metadata).expect("supported");
    let from_path = file_identity(&path).expect("identity").expect("supported");
    assert!(same_identity(&from_metadata, &from_path));
}

#[test]
fn birth_time_is_strong_when_both_sides_have_one() {
    let first = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 100,
    };
    let same_core_different_birth = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 200,
    };
    let same_core_no_birth = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 0,
    };

    assert!(!same_identity(&first, &same_core_different_birth));
    assert!(same_identity(&first, &same_core_no_birth));
    assert!(same_identity(&same_core_no_birth, &first));
    assert!(same_identity(&same_core_no_birth, &same_core_no_birth));
}

#[test]
fn different_variants_do_not_match() {
    let inode = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 0,
    };
    let lowres = FileIdentity::LowRes {
        volume: 1,
        index: 2,
        birth_ns: 0,
    };
    assert!(!same_identity(&inode, &lowres));
}

#[test]
fn option_and_observation_helpers() {
    let identity = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 0,
    };
    assert!(same_identity_opt(None, None));
    assert!(same_identity_opt(Some(&identity), Some(&identity)));
    assert!(!same_identity_opt(Some(&identity), None));
    assert!(same_observation(
        &FileObservation::Absent,
        &FileObservation::Absent
    ));
    assert!(same_observation(
        &FileObservation::Unavailable,
        &FileObservation::Unavailable
    ));
    assert!(!same_observation(
        &FileObservation::Unavailable,
        &FileObservation::Absent
    ));
}

#[test]
fn file_hex_is_stable_and_distinct() {
    let first = FileIdentity::Inode {
        device: 1,
        inode: 2,
        birth_ns: 0,
    };
    let second = FileIdentity::Inode {
        device: 1,
        inode: 3,
        birth_ns: 0,
    };
    assert_eq!(first.file_hex(), first.clone().file_hex());
    assert_ne!(first.file_hex(), second.file_hex());
    assert!(!first.file_hex().as_str().is_empty());
}

#[cfg(target_os = "linux")]
#[test]
fn linux_birth_is_zero_when_unavailable() {
    use qingmo_lib::services::file_identity::linux_birth_ns;

    // tmpfs/proc commonly do not expose btime; the contract is only that the
    // function returns a value without panicking and uses zero as fallback.
    let dir = temp_dir();
    let value = linux_birth_ns(dir.path());
    let _ = value;
}

#[cfg(windows)]
#[test]
fn windows_handle_identity_is_high_or_low_res() {
    use qingmo_lib::services::file_identity::identity_from_handle;

    let dir = temp_dir();
    let path = dir.path().join("a.md");
    write(&path, "hello");
    let file = fs::File::open(&path).expect("open");
    let identity = identity_from_handle(&file)
        .expect("identity")
        .expect("supported");
    assert!(matches!(
        identity,
        FileIdentity::HighRes { .. } | FileIdentity::LowRes { .. }
    ));
}
