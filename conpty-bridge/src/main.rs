// ConPTY bridge for obsidian-copilot
// Based on obsidian-ai-terminal (MIT License, Copyright (c) 2026 theco)
// Adapted for Copilot CLI integration

mod conpty;
mod pipe_relay;

use std::env;
use std::process;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
use windows::Win32::System::Threading::{WaitForSingleObject, GetExitCodeProcess, INFINITE};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 5 {
        eprintln!("Usage: conpty-bridge <cols> <rows> <cwd> <shell>");
        process::exit(1);
    }

    let cols: i16 = args[1].parse().unwrap_or(80);
    let rows: i16 = args[2].parse().unwrap_or(24);
    let cwd = &args[3];
    let shell = &args[4];

    let stdin_handle = unsafe {
        GetStdHandle(STD_INPUT_HANDLE).unwrap_or(HANDLE::default())
    };

    let env_block = conpty::build_env_block(&[
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("COLUMNS", &cols.to_string()),
        ("LINES", &rows.to_string()),
    ]);

    let pty = match conpty::ConPty::new(cols, rows) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to create ConPTY: {}", e);
            process::exit(1);
        }
    };

    let (pi, job) = match pty.spawn(shell, cwd, &env_block) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to spawn process: {}", e);
            process::exit(1);
        }
    };

    let output_thread = pipe_relay::relay_output(pty.output_client);
    let _input_thread = pipe_relay::relay_input(pty.input_client, &pty, stdin_handle);

    unsafe {
        WaitForSingleObject(pi.hProcess, INFINITE);

        let mut exit_code: u32 = 0;
        let _ = GetExitCodeProcess(pi.hProcess, &mut exit_code);

        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(job);

        drop(pty);

        let _ = output_thread.join();

        process::exit(exit_code as i32);
    }
}
