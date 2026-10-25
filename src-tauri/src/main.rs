// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // must run first: Velopack may finish an install/update step and exit here
    velopack::VelopackApp::build().run();
    personal_downloader_lib::run()
}
