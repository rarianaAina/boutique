// Empêche l'ouverture d'une console derrière la fenêtre sous Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    boutique_lib::run()
}
