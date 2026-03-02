//! Minimal static HTTP server used for local development.
//!
//! The server intentionally keeps dependencies at zero so it can be compiled
//! quickly in constrained environments. It supports:
//! - `GET` / `HEAD`,
//! - MIME type detection for common web assets,
//! - path sanitization to prevent directory traversal.

use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::thread;

/// Default host for local serving.
const DEFAULT_HOST: &str = "127.0.0.1";
/// Default port for local serving.
const DEFAULT_PORT: u16 = 4173;

/// Entry point for the standalone static server binary.
fn main() {
    let mut root = env::current_dir().expect("failed to read current directory");
    let mut host = DEFAULT_HOST.to_string();
    let mut port = DEFAULT_PORT;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                if let Some(value) = args.next() {
                    root = PathBuf::from(value);
                }
            }
            "--host" => {
                if let Some(value) = args.next() {
                    host = value;
                }
            }
            "--port" => {
                if let Some(value) = args.next() {
                    port = value.parse().unwrap_or(DEFAULT_PORT);
                }
            }
            "--help" | "-h" => {
                print_help();
                return;
            }
            _ => {}
        }
    }

    let address = format!("{host}:{port}");
    let listener = TcpListener::bind(&address).unwrap_or_else(|err| {
        panic!("failed to bind {address}: {err}");
    });

    println!("Serving {}", root.display());
    println!("Open http://{address}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let root = root.clone();
                thread::spawn(move || {
                    if let Err(err) = handle_connection(stream, &root) {
                        eprintln!("request error: {err}");
                    }
                });
            }
            Err(err) => eprintln!("connection failed: {err}"),
        }
    }
}

/// Prints CLI usage help.
fn print_help() {
    println!("Rust static file server");
    println!("Usage: cargo run --manifest-path tools/static-server/Cargo.toml -- [--root <path>] [--host <ip>] [--port <port>]");
}

/// Handles one inbound HTTP connection.
fn handle_connection(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("/");

    let mut headers = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        headers.push_str(&line);
    }

    if method != "GET" && method != "HEAD" {
        return write_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
            method == "HEAD",
        );
    }

    let target = strip_query(raw_target);
    let decoded = percent_decode(target);
    let Some(safe_path) = sanitize_path(&decoded) else {
        return write_response(
            &mut stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"Bad Request",
            method == "HEAD",
        );
    };

    let mut path = root.join(safe_path);
    if path.is_dir() {
        path = path.join("index.html");
    }

    match fs::read(&path) {
        Ok(bytes) => {
            let mime = mime_type_for(&path);
            write_response(&mut stream, "200 OK", mime, &bytes, method == "HEAD")
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
            method == "HEAD",
        ),
        Err(_) => write_response(
            &mut stream,
            "500 Internal Server Error",
            "text/plain; charset=utf-8",
            b"Internal Server Error",
            method == "HEAD",
        ),
    }
}

/// Removes query parameters from a URL target path.
fn strip_query(input: &str) -> &str {
    input.split('?').next().unwrap_or(input)
}

/// Decodes `%xx` and `+` escaped bytes in URL paths.
fn percent_decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = bytes[i + 1] as char;
            let lo = bytes[i + 2] as char;
            if let (Some(h), Some(l)) = (hi.to_digit(16), lo.to_digit(16)) {
                out.push(((h * 16 + l) as u8) as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    out
}

/// Converts a request path into a safe relative filesystem path.
fn sanitize_path(path: &str) -> Option<PathBuf> {
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    let normalized = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    let candidate = Path::new(normalized);

    let mut safe = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            Component::CurDir => {}
            Component::RootDir => {}
            _ => return None,
        }
    }
    Some(safe)
}

/// Maps file extension to HTTP Content-Type.
fn mime_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Writes a complete HTTP response to the stream.
fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let mut response = Vec::new();
    response.extend_from_slice(format!("HTTP/1.1 {status}\r\n").as_bytes());
    response.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
    response.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    response.extend_from_slice(b"Connection: close\r\n");
    response.extend_from_slice(b"Cache-Control: no-cache\r\n");
    response.extend_from_slice(b"\r\n");
    if !head_only {
        response.extend_from_slice(body);
    }
    stream.write_all(&response)?;
    stream.flush()?;
    Ok(())
}
