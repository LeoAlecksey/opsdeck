use tauri::Manager;

mod ai;
mod aichat;
mod alerts;
mod cmdindex;
mod code;
mod connectors;
mod db;
mod diag;
mod editor;
mod embed;
mod i18n;
mod ide;
mod k8s;
mod k8s_events;
mod keepass;
mod mikrotik;
mod notes;
mod ports;
mod process;
mod pty;
mod settings;
mod snippets;
mod ssh;
mod sysmon;
mod store;
mod tasks;
mod tools;
mod transfer;
mod updater;
mod winbox_import;
mod winshell;

/// The main window, from tauri.conf.json ("create": false there).
fn main_window(app: &tauri::App) -> tauri::Result<()> {
    let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window in tauri.conf.json");
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
    // e2e tests on Windows: msedgedriver enables DevTools through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    // which WebView2 150+ ignores in elevated processes (GitHub's Windows runners); passed through the
    // API it works. Debug builds only — release builds keep the runtime's hardening.
    #[cfg(all(windows, debug_assertions))]
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        builder = builder.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {extra}"));
    }
    builder.build()?;
    Ok(())
}

pub fn run() {
    #[cfg(target_os = "macos")]
    process::fix_macos_path();

    tauri::Builder::default()
        .plugin(diag::log_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(tools::ToolState::default())
        .manage(k8s::K8sState::default())
        .manage(keepass::KeepassState::default())
        .manage(ide::IdeState::default())
        .manage(alerts::AlertsState::default())
        .manage(sysmon::SysState::default())
        .manage(ai::AiState::default())
        .manage(k8s_events::EventsState::default())
        .manage(aichat::ChatState::default())
        .setup(|app| {
            diag::install_panic_hook();
            main_window(app)?;
            diag::start_watchdog(app.handle().clone());
            log::info!("OpsDeck {} started", app.package_info().version);
            keepass::spawn_autolock(app.handle().clone());
            tasks::spawn_reminders(app.handle().clone());
            ai::spawn_idle_stop(app.handle().clone());
            k8s_events::spawn(app.handle().clone());
            ide::start(app.handle().clone());
            embed::install(app.handle());
            alerts::load_data(&app.state::<alerts::AlertsState>());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = alerts::restart(&handle).await {
                    log::error!("alerts: {e}");
                    let _ = tauri::Emitter::emit(&handle, "alerts-error", e);
                }
            });
            Ok(())
        })
        .invoke_handler(diag::track(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            diag::log_ui,
            diag::logs_open,
            diag::logs_tail,
            diag::logs_path,
            pty::pty_record_start,
            pty::pty_record_stop,
            pty::pty_records_open,
            pty::shell_commands,
            editor::fs_list,
            editor::fs_git_status,
            editor::fs_resolve,
            editor::fs_reveal,
            editor::editors_detect,
            editor::editor_open,
            tools::tool_run,
            tools::tool_stop,
            connectors::connectors_list,
            connectors::connector_save,
            connectors::connector_delete,
            connectors::connector_open,
            connectors::connector_regen_token,
            embed::web_embed_show,
            embed::web_embed_hide,
            embed::web_embed_close,
            embed::web_embed_nav,
            embed::open_external,
            k8s::k8s_contexts,
            k8s::k8s_import,
            k8s::k8s_remove_source,
            k8s::k8s_shell_config,
            k8s::k8s_list,
            k8s::k8s_get_yaml,
            k8s::k8s_apply_yaml,
            k8s::k8s_delete,
            k8s::k8s_scale,
            k8s::k8s_restart,
            k8s::k8s_logs_start,
            k8s::k8s_logs_stop,
            k8s::k8s_logs_workload_start,
            k8s::k8s_prefs_get,
            k8s::k8s_prefs_set,
            k8s::k8s_delete_context,
            k8s::k8s_system_contexts,
            k8s::k8s_import_contexts,
            k8s::k8s_watch_start,
            k8s::k8s_watch_stop,
            k8s::k8s_metrics,
            k8s::k8s_helm_releases,
            k8s::k8s_helm_release,
            k8s::k8s_argo_action,
            k8s::k8s_crds,
            k8s::k8s_object_events,
            settings::settings_get,
            settings::settings_set,
            settings::settings_detect,
            keepass::kp_status,
            keepass::kp_unlock,
            keepass::kp_lock,
            keepass::kp_entries,
            keepass::kp_copy,
            keepass::kp_reveal,
            keepass::kp_notes,
            keepass::kp_open_external,
            keepass::clip_write,
            keepass::clip_read,
            code::code_read,
            code::code_write,
            code::code_create,
            code::code_tf_fmt,
            code::code_git_log,
            code::code_git_stamp,
            code::code_git_diff,
            code::code_git_show,
            code::code_git_branches,
            code::code_git_op,
            code::pick_folder,
            i18n::set_lang,
            ai::ai_status,
            ai::ai_install,
            ai::ai_cancel,
            ai::ai_remove,
            ai::ai_models,
            ai::ai_select,
            ai::ai_remove_model,
            ai::ai_pick_model,
            ai::ai_set_gpu,
            ai::ai_command,
            ai::ai_test,
            winshell::win_shells,
            aichat::ai_chat,
            k8s_events::k8s_history,
            k8s_events::k8s_history_set,
            k8s_events::k8s_history_clear,
            transfer::transfer_parts,
            transfer::transfer_export,
            transfer::transfer_pick,
            transfer::transfer_inspect,
            transfer::transfer_import,
            transfer::app_restart,
            aichat::ai_chat_stop,
            winshell::wt_settings,
            winbox_import::mt_import_scan,
            winbox_import::mt_import,
            winbox_import::mt_import_pick,
            settings::ai_key_clear,
            cmdindex::cmd_suggest,
            db::db_list,
            db::db_save,
            db::db_delete,
            db::db_test,
            db::db_query,
            db::db_tree,
            mikrotik::mt_list,
            mikrotik::mt_save,
            mikrotik::mt_delete,
            mikrotik::mt_winbox,
            mikrotik::mt_ssh,
            notes::notes_list,
            notes::note_read,
            notes::note_write,
            notes::note_move,
            notes::note_delete,
            notes::vaults_list,
            notes::vault_open,
            notes::vault_create,
            notes::vault_activate,
            notes::vault_forget,
            notes::vault_validate_path,
            notes::notes_tags,
            tasks::tasks_list,
            tasks::task_update,
            tasks::task_format,
            tasks::task_add,
            tasks::task_snooze,
            notes::note_search,
            notes::note_open_obsidian,
            notes::note_daily,
            snippets::snippets_list,
            updater::update_check,
            updater::app_version,
            updater::update_install,
            updater::releases_list,
            alerts::alerts_get,
            alerts::alerts_ack,
            alerts::alerts_clear,
            alerts::alerts_config_get,
            alerts::alerts_config_set,
            alerts::alerts_poll_now,
            alerts::alerts_resolve,
            alerts::alerts_mute,
            alerts::alerts_test_source,
            alerts::alerts_sources,
            ssh::ssh_list,
            ssh::ssh_keys,
            ssh::ssh_save,
            ssh::ssh_delete,
            ssh::ssh_connect,
            ssh::ssh_local_user,
            ssh::ssh_config_group,
            ssh::ssh_group_rename,
            sysmon::sys_local,
            sysmon::sys_remote,
            sysmon::mon_probe,
            ports::ports_scan,
            ports::ports_listening,
            snippets::snippets_save,
            ide::ide_selection,
            ide::ide_editor,
            ide::ide_at_mention,
            ide::ide_status,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building OpsDeck")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                k8s_events::flush(app);
                log::info!("OpsDeck exiting");
                ide::cleanup(app);
                ai::shutdown(app);
                #[cfg(target_os = "linux")]
                embed::release_layer();
            }
        });
}

