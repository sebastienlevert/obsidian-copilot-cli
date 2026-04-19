// I/O relay threads for ConPTY bridge
// Based on obsidian-ai-terminal (MIT License, Copyright (c) 2026 theco)

use std::io::{self, Write};
use std::thread;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Console::{HPCON, COORD, ResizePseudoConsole};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};

use crate::conpty::ConPty;

const RESIZE_PREFIX: &[u8] = b"\x1b]resize";
const RESIZE_TERMINATOR: u8 = 0x07;

/// ConPTY output -> stdout relay (separate thread)
pub fn relay_output(output_client: HANDLE) -> thread::JoinHandle<()> {
    let raw = output_client.0 as isize;
    thread::spawn(move || {
        let h = HANDLE(raw as *mut _);
        let mut buf = [0u8; 65536];
        let stdout = io::stdout();
        loop {
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(h, Some(&mut buf), Some(&mut bytes_read), None)
            };
            if ok.is_err() || bytes_read == 0 {
                break;
            }
            let mut out = stdout.lock();
            if out.write_all(&buf[..bytes_read as usize]).is_err() {
                break;
            }
            let _ = out.flush();
        }
    })
}

/// stdin -> ConPTY input relay with resize sequence parsing (separate thread)
pub fn relay_input(input_client: HANDLE, conpty: &ConPty, stdin_handle: HANDLE) -> thread::JoinHandle<()> {
    let write_raw = input_client.0 as isize;
    let hpc_raw = conpty.hpc.0 as isize;
    let stdin_raw = stdin_handle.0 as isize;

    thread::spawn(move || {
        let write_h = HANDLE(write_raw as *mut _);
        let hpc = HPCON(hpc_raw);
        let stdin_h = HANDLE(stdin_raw as *mut _);

        let mut buf = [0u8; 65536];
        loop {
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(stdin_h, Some(&mut buf), Some(&mut bytes_read), None)
            };
            if ok.is_err() || bytes_read == 0 {
                break;
            }

            let n = bytes_read as usize;
            let data = &buf[..n];
            let mut i = 0;

            while i < data.len() {
                // Detect resize sequence: \x1b]resize;<cols>;<rows>\x07
                if data[i..].starts_with(RESIZE_PREFIX) {
                    if let Some(end_offset) = data[i..].iter().position(|&b| b == RESIZE_TERMINATOR) {
                        let seq = &data[i + RESIZE_PREFIX.len()..i + end_offset];
                        if let Ok(params_str) = std::str::from_utf8(seq) {
                            let params: Vec<&str> = params_str.trim_start_matches(';').split(';').collect();
                            if params.len() == 2 {
                                if let (Ok(cols), Ok(rows)) = (params[0].parse::<i16>(), params[1].parse::<i16>()) {
                                    unsafe {
                                        let size = COORD { X: cols, Y: rows };
                                        let _ = ResizePseudoConsole(hpc, size);
                                    }
                                }
                            }
                        }
                        i += end_offset + 1;
                        continue;
                    }
                }

                let next_resize = data[i + 1..].windows(RESIZE_PREFIX.len())
                    .position(|w| w == RESIZE_PREFIX)
                    .map(|p| p + i + 1);

                let end = next_resize.unwrap_or(data.len());
                let chunk = &data[i..end];

                let mut written: u32 = 0;
                let ok = unsafe {
                    WriteFile(write_h, Some(chunk), Some(&mut written), None)
                };
                if ok.is_err() {
                    return;
                }

                i = end;
            }
        }
    })
}
