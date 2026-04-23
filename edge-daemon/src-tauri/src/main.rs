#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    antp_edge_daemon::run();
}
