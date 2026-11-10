//! Download worker: resume, cancellation, hash failure and single-slot state.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use qingmo_lib::error::AppErrorCode;
use qingmo_lib::ipc::dto::DownloadState;
use qingmo_lib::services::meeting::download::run;
use qingmo_lib::services::meeting::models::{
    ArchiveFormat, ArchiveSpec, FileRole, License, ModelFile, ModelKind, ModelPack, PeakBasis,
    SourceUrl,
};
use qingmo_lib::state::meeting::downloads::ModelDownloads;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const BODY: &[u8] = b"0123456789";
const SHA: &str = "84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882";

static SOURCE: [SourceUrl; 1] = [SourceUrl {
    url: "http://127.0.0.1",
    commit: "test",
}];
static FILES: [ModelFile; 1] = [ModelFile {
    name: "file.bin",
    role: FileRole::Model,
    sha256: SHA,
    bytes: 10,
    source: SOURCE[0],
}];
static PACK: ModelPack = ModelPack {
    id: "test-pack",
    display: "Test",
    kind: ModelKind::Asr,
    family: None,
    license: License::Mit,
    license_url: "https://example.invalid",
    languages: &[],
    peak_memory_mb: 1,
    peak_basis: PeakBasis::MeasuredRss,
    group: None,
    download_bytes: 10,
    install_bytes: 10,
    source: &SOURCE,
    archive: None,
    files: &FILES,
};

fn pack(url: &'static str) -> ModelPack {
    let source: &'static [SourceUrl] = Box::leak(Box::new([SourceUrl {
        url,
        commit: "test",
    }]));
    let files: &'static [ModelFile] = Box::leak(Box::new([ModelFile {
        source: SourceUrl {
            url,
            commit: "test",
        },
        ..FILES[0]
    }]));
    ModelPack {
        source,
        files,
        ..PACK
    }
}

fn temp_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-download-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One-shot HTTP server; records the `Range` header when present.
fn serve(body: &'static [u8], ranges: Arc<Mutex<Vec<String>>>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 2048];
        let read = stream.read(&mut request).unwrap();
        let text = String::from_utf8_lossy(&request[..read]);
        let range = text
            .lines()
            .find_map(|line| line.strip_prefix("range: bytes=").map(str::to_owned))
            .or_else(|| {
                text.lines()
                    .find_map(|line| line.strip_prefix("Range: bytes=").map(str::to_owned))
            });
        if let Some(value) = range {
            ranges.lock().unwrap().push(value.clone());
            let start: usize = value.trim_end_matches('-').parse().unwrap();
            let remaining = &body[start..];
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                remaining.len()
            )
            .unwrap();
            stream.write_all(remaining).unwrap();
        } else {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        }
        stream.flush().unwrap();
    });
    addr
}

#[test]
fn resumes_a_partial_file_and_writes_ready() {
    let root = temp_root();
    let id = Uuid::new_v4();
    // A previous attempt with a different download id left this `.part`.
    let staging = root.join(".staging").join("test-pack");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("file.bin.part"), b"0123").unwrap();
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let addr = serve(BODY, ranges.clone());
    let url: &'static str = Box::leak(format!("http://{addr}/file.bin").into_boxed_str());
    let pack = pack(url);
    let mut states = Vec::new();

    run(
        &root,
        &pack,
        id,
        &CancellationToken::new(),
        &mut |done, state| {
            states.push((done, state));
        },
    )
    .expect("resume must succeed");

    assert_eq!(ranges.lock().unwrap().as_slice(), ["4-"]);
    assert_eq!(
        std::fs::read(root.join("test-pack").join("file.bin")).unwrap(),
        BODY
    );
    assert!(root.join("test-pack").join(".ready").is_file());
    assert_eq!(states.last().unwrap().0, 10);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_hash_mismatch_deletes_the_file_and_reports_the_reason() {
    let root = temp_root();
    let id = Uuid::new_v4();
    let addr = serve(b"wrongwrong", Arc::new(Mutex::new(Vec::new())));
    let url: &'static str = Box::leak(format!("http://{addr}/file.bin").into_boxed_str());

    let error = run(
        &root,
        &pack(url),
        id,
        &CancellationToken::new(),
        &mut |_, _| {},
    )
    .expect_err("hash must fail");
    assert_eq!(error.code, AppErrorCode::ModelDownloadFailed);
    assert_eq!(error.details.unwrap()["reason"], "hash_mismatch");
    assert!(!root.join("test-pack").join("file.bin").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn cancellation_stops_the_worker_and_keeps_the_part() {
    let root = temp_root();
    let id = Uuid::new_v4();
    let addr = serve(BODY, Arc::new(Mutex::new(Vec::new())));
    let url: &'static str = Box::leak(format!("http://{addr}/file.bin").into_boxed_str());
    let token = CancellationToken::new();
    let token_for_cb = token.clone();

    let error = run(&root, &pack(url), id, &token, &mut |_, _| {
        token_for_cb.cancel();
    })
    .expect_err("cancel must abort");
    assert_eq!(error.code, AppErrorCode::Cancelled);
    assert!(root
        .join(".staging")
        .join("test-pack")
        .join("file.bin.part")
        .exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_slot_rejects_a_second_download_until_done() {
    let downloads = ModelDownloads::new();
    let (id, _) = downloads.begin("test-pack", 10).unwrap();
    assert_eq!(
        downloads.begin("other", 1).unwrap_err().code,
        AppErrorCode::ModelBusy
    );
    downloads.done(id);
    downloads
        .begin("other", 1)
        .expect("terminal releases the slot");
}

#[test]
fn removing_waits_for_the_cancelled_worker_to_settle() {
    let downloads = Arc::new(ModelDownloads::new());
    let (id, token) = downloads.begin("test-pack", 10).unwrap();
    let worker = downloads.clone();
    let handle = std::thread::spawn(move || {
        while !token.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        worker.fail(
            id,
            qingmo_lib::error::AppError::new(AppErrorCode::Cancelled, "stop"),
        );
    });
    assert!(downloads.cancel_and_wait("test-pack", Duration::from_secs(2)));
    handle.join().unwrap();
    assert!(downloads.overlay("test-pack").is_none());
    let _ = DownloadState::Done;
}

fn archive_pack(body: Vec<u8>, root_files: &'static [&'static str]) -> (Vec<u8>, ModelPack) {
    let mut tar_bytes = Vec::new();
    {
        let encoder = bzip2::write::BzEncoder::new(&mut tar_bytes, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "root/file.bin", body.as_slice())
            .unwrap();
        builder.finish().unwrap();
    }
    let sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&tar_bytes))
    };
    let bytes = tar_bytes.len() as u64;
    let spec = ArchiveSpec {
        format: ArchiveFormat::TarBz2,
        root: "root",
        root_files,
        bytes,
        sha256: Box::leak(sha.into_boxed_str()),
    };
    let archive: &'static ArchiveSpec = Box::leak(Box::new(spec));
    let mut pack = pack("http://127.0.0.1");
    pack.archive = Some(*archive);
    pack.download_bytes = bytes;
    pack.install_bytes = body.len() as u64;
    (tar_bytes, pack)
}

#[test]
fn installs_a_valid_archive_and_removes_it() {
    let root = temp_root();
    let id = Uuid::new_v4();
    let (archive, pack) = archive_pack(b"0123456789".to_vec(), &["file.bin"]);
    let addr = serve(
        Box::leak(archive.into_boxed_slice()),
        Arc::new(Mutex::new(Vec::new())),
    );
    let url: &'static str = Box::leak(format!("http://{addr}/archive.tar.bz2").into_boxed_str());
    let mut pack = pack;
    pack.source = Box::leak(Box::new([SourceUrl {
        url,
        commit: "test",
    }]));

    run(&root, &pack, id, &CancellationToken::new(), &mut |_, _| {}).expect("archive");
    assert_eq!(
        std::fs::read(root.join("test-pack/file.bin")).unwrap(),
        b"0123456789"
    );
    assert!(root.join("test-pack/.ready").is_file());
    assert!(!root
        .join(".staging")
        .join("test-pack")
        .join("archive.tar.bz2")
        .exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn rejects_archive_links_and_too_many_entries() {
    fn build(entries: usize, link: bool) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let encoder = bzip2::write::BzEncoder::new(&mut out, bzip2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            for _ in 0..entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(1);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, "root/extra", b"x".as_slice())
                    .unwrap();
            }
            if link {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.set_link_name("root/file.bin").unwrap();
                header.set_cksum();
                builder
                    .append_link(&mut header, "root/link", "root/file.bin")
                    .unwrap();
            }
            builder.finish().unwrap();
        }
        out
    }

    for (entries, link, reason) in [
        (1usize, true, "archive_link"),
        (2001usize, false, "archive_bomb"),
    ] {
        let root = temp_root();
        let id = Uuid::new_v4();
        let (_archive, mut pack) = archive_pack(b"x".to_vec(), &["file.bin"]);
        let bytes = build(entries, link);
        let len = bytes.len() as u64;
        let sha = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(&bytes))
        };
        let mut spec = pack.archive.unwrap();
        spec.bytes = len;
        spec.sha256 = Box::leak(sha.into_boxed_str());
        spec.root_files = &[];
        pack.archive = Some(spec);
        let addr = serve(
            Box::leak(bytes.into_boxed_slice()),
            Arc::new(Mutex::new(Vec::new())),
        );
        let url: &'static str =
            Box::leak(format!("http://{addr}/archive.tar.bz2").into_boxed_str());
        pack.source = Box::leak(Box::new([SourceUrl {
            url,
            commit: "test",
        }]));
        let error = run(&root, &pack, id, &CancellationToken::new(), &mut |_, _| {})
            .expect_err("archive must fail");
        assert_eq!(error.details.unwrap()["reason"], reason);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn replaces_an_existing_directory_and_drops_the_backup() {
    let root = temp_root();
    let id = Uuid::new_v4();
    let existing = root.join("test-pack");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::write(existing.join("old.bin"), b"old").unwrap();
    let addr = serve(BODY, Arc::new(Mutex::new(Vec::new())));
    let url: &'static str = Box::leak(format!("http://{addr}/file.bin").into_boxed_str());

    run(
        &root,
        &pack(url),
        id,
        &CancellationToken::new(),
        &mut |_, _| {},
    )
    .expect("replace");
    assert_eq!(std::fs::read(existing.join("file.bin")).unwrap(), BODY);
    assert!(!existing.join("old.bin").exists());
    let leftovers: Vec<_> = std::fs::read_dir(root.join(".staging"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".old-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn rejects_an_unpacked_size_bomb() {
    let big = vec![0u8; 65 * 1024 * 1024];
    let (archive, mut pack) = archive_pack(big.clone(), &["file.bin"]);
    let root = temp_root();
    let id = Uuid::new_v4();
    let addr = serve(
        Box::leak(archive.into_boxed_slice()),
        Arc::new(Mutex::new(Vec::new())),
    );
    let url: &'static str = Box::leak(format!("http://{addr}/archive.tar.bz2").into_boxed_str());
    pack.source = Box::leak(Box::new([SourceUrl {
        url,
        commit: "test",
    }]));

    let error = run(&root, &pack, id, &CancellationToken::new(), &mut |_, _| {})
        .expect_err("bomb must fail");
    assert_eq!(error.details.unwrap()["reason"], "archive_bomb");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_verified_archive_is_reused_after_an_unpack_failure() {
    let root = temp_root();
    let first_id = Uuid::new_v4();
    let (archive, mut pack) = archive_pack(b"0123456789".to_vec(), &["file.bin", "absent.bin"]);
    let addr = serve(
        Box::leak(archive.into_boxed_slice()),
        Arc::new(Mutex::new(Vec::new())),
    );
    let url: &'static str = Box::leak(format!("http://{addr}/archive.tar.bz2").into_boxed_str());
    pack.source = Box::leak(Box::new([SourceUrl {
        url,
        commit: "test",
    }]));

    let error = run(
        &root,
        &pack,
        first_id,
        &CancellationToken::new(),
        &mut |_, _| {},
    )
    .expect_err("missing declared file must fail");
    assert_eq!(error.details.unwrap()["reason"], "archive_missing");
    assert!(root.join(".staging/test-pack/archive.tar.bz2").is_file());

    // The second attempt must not touch the network.
    let mut spec = pack.archive.unwrap();
    spec.root_files = &["file.bin"];
    pack.archive = Some(spec);
    pack.source = Box::leak(Box::new([SourceUrl {
        url: "http://127.0.0.1:1/archive.tar.bz2",
        commit: "test",
    }]));
    run(
        &root,
        &pack,
        Uuid::new_v4(),
        &CancellationToken::new(),
        &mut |_, _| {},
    )
    .expect("reused archive");
    assert_eq!(
        std::fs::read(root.join("test-pack/file.bin")).unwrap(),
        b"0123456789"
    );
    assert!(!root.join(".staging/test-pack/archive.tar.bz2").exists());
    let _ = std::fs::remove_dir_all(root);
}
