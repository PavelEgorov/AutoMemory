/**
 * Панель настроек: привязка полей и отрисовка состояния.
 * Каждое поле пишет в настройки сразу, отдельной кнопки «сохранить» нет.
 */

import {
    getSettings, saveSettings, resetPrompt, tell, warn,
    currentAvatar, currentName, nameOf, bindingFor, setBinding,
} from './settings.js';
import { listWorlds, checkBinding, ensureEntry } from './lorebook.js';
import { testConnection, sourceName } from './connection.js';
import * as logfile from './logfile.js';

const DEFAULT_ENTRY = 'AutoMemory';

/** Показать итог операции в строке под кнопкой. */
function status(id, ok, text) {
    const el = $(id);
    el.text(text);
    el.removeClass('am-ok am-fail').addClass(ok ? 'am-ok' : 'am-fail');
}

// ─── Отрисовка ───────────────────────────────────────────────────────

/** Список миров в выпадающем поле связки. */
export function refreshWorlds() {
    const select = $('#am_world');
    const chosen = bindingFor(currentAvatar())?.world || '';
    select.empty();
    select.append($('<option>').val('').text('— мир не выбран —'));
    for (const name of listWorlds()) {
        select.append($('<option>').val(name).text(name));
    }
    select.val(chosen);
}

/** Выпадающий список профилей подключения — его наполняет сама таверна. */
export function refreshProfiles() {
    const s = getSettings();
    try {
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        if (!service?.handleDropdown) {
            $('#am_profile').empty().append($('<option>').val('').text('менеджер подключений недоступен'));
            return;
        }
        service.handleDropdown('#am_profile', s.connectionProfileId, (profile) => {
            getSettings().connectionProfileId = profile?.id || '';
            saveSettings();
            $('#am_source_name').text(sourceName());
        });
    } catch (e) {
        warn('список профилей не собрался:', e);
        $('#am_profile').empty().append($('<option>').val('').text('профили недоступны'));
    }
}

/**
 * Заведённые персонажи: строка на связку с кнопкой удаления.
 * Персонажа заводит человек — связка и есть включение расширения для него.
 */
export function refreshBindings() {
    const box = $('#am_bindings');
    const bindings = getSettings().bindings;
    const current = currentAvatar();
    box.empty();

    const avatars = Object.keys(bindings);
    if (avatars.length === 0) {
        box.append($('<div>').addClass('am-bindings-empty')
            .text('пока никого — выберите мир и запись для открытого персонажа'));
        return;
    }

    for (const avatar of avatars) {
        const b = bindings[avatar] || {};
        const row = $('<div>').addClass('am-bind-row');
        if (avatar === current) row.addClass('am-bind-current').attr('title', 'текущий персонаж');
        const label = b.world
            ? `${nameOf(avatar)} → ${b.world} / ${b.entry || DEFAULT_ENTRY}`
            : `${nameOf(avatar)} → связка неполная, заведите заново`;
        row.append($('<span>').text(label));
        row.append($('<button>').addClass('menu_button am-bind-del').text('✕')
            .attr('title', 'убрать персонажа')
            .on('click', () => {
                setBinding(avatar, '');
                refreshPanel();
            }));
        box.append(row);
    }
}

/** Последняя операция: итог и содержимое файла. */
export function refreshLog() {
    const data = logfile.read();
    $('#am_last_operation').text(logfile.describe(data));
    $('#am_log').val(logfile.render(data));
}

/** Всё состояние панели разом. */
export function refreshPanel() {
    const s = getSettings();
    const avatar = currentAvatar();

    $('#am_enabled').prop('checked', s.enabled);
    $('#am_strip').prop('checked', s.stripCommands);
    $('#am_show_errors').prop('checked', s.showErrors);

    $('#am_character_name').text(currentName() || 'персонаж не выбран');

    const binding = bindingFor(avatar);
    $('#am_world').val(binding?.world || '');
    $('#am_entry').val(binding?.entry || DEFAULT_ENTRY);

    $('#am_source').val(s.connectionSource);
    $('#am_profile_row').toggle(s.connectionSource === 'profile');
    $('#am_source_name').text(sourceName());

    $('#am_prompt').val(s.systemPrompt);
    $('#am_max_tokens').val(s.maxTokens);

    refreshBindings();
    refreshLog();
}

// ─── Привязка полей ──────────────────────────────────────────────────

export function bindUI() {
    // Общее
    $('#am_enabled').on('change', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
    });

    $('#am_strip').on('change', function () {
        getSettings().stripCommands = $(this).prop('checked');
        saveSettings();
    });

    $('#am_show_errors').on('change', function () {
        getSettings().showErrors = $(this).prop('checked');
        saveSettings();
    });

    // Связка персонаж — мир — блокнот
    $('#am_world').on('change', function () {
        const avatar = currentAvatar();
        if (!avatar) {
            tell('warning', 'сначала откройте персонажа');
            refreshPanel();
            return;
        }
        setBinding(avatar, $(this).val(), $('#am_entry').val() || DEFAULT_ENTRY);
        status('#am_binding_status', true, 'связка сохранена');
        refreshBindings();
    });

    $('#am_entry').on('change input', function () {
        const avatar = currentAvatar();
        if (!avatar) return;
        const world = $('#am_world').val();
        if (!world) return;
        setBinding(avatar, world, $(this).val() || DEFAULT_ENTRY);
        refreshBindings();
    });

    $('#am_check_binding').on('click', async function () {
        const world = $('#am_world').val();
        const entry = $('#am_entry').val() || DEFAULT_ENTRY;
        const result = await checkBinding(world, entry);
        status('#am_binding_status', result.ok, result.reason);
    });

    $('#am_create_entry').on('click', async function () {
        const world = $('#am_world').val();
        const entry = $('#am_entry').val() || DEFAULT_ENTRY;
        if (!world) {
            status('#am_binding_status', false, 'мир не выбран');
            return;
        }
        const result = await ensureEntry(world, entry);
        status('#am_binding_status', result.ok, result.reason);
        if (result.ok) {
            const avatar = currentAvatar();
            if (avatar) setBinding(avatar, world, entry);
            refreshBindings();
        }
    });

    // Подключение ИИ
    $('#am_source').on('change', function () {
        getSettings().connectionSource = $(this).val();
        saveSettings();
        refreshPanel();
    });

    $('#am_max_tokens').on('change input', function () {
        const value = parseInt($(this).val(), 10);
        getSettings().maxTokens = Number.isFinite(value) && value > 0 ? value : 2000;
        saveSettings();
    });

    $('#am_check_connection').on('click', async function () {
        status('#am_connection_status', true, 'спрашиваю…');
        const result = await testConnection();
        status('#am_connection_status', result.ok, result.reason);
    });

    // Промт для ИИ
    $('#am_prompt').on('change input', function () {
        getSettings().systemPrompt = $(this).val();
        saveSettings();
    });

    $('#am_reset_prompt').on('click', function () {
        resetPrompt();
        refreshPanel();
        tell('info', 'промт возвращён к исходному');
    });

    // Последняя операция
    $('#am_clear_log').on('click', async function () {
        try {
            await logfile.clear();
        } catch (e) {
            tell('error', 'файл не очистился');
            warn('файл последней операции не очистился:', e);
        }
        refreshLog();
    });
}
