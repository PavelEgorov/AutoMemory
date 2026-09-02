/**
 * AutoMemory — ИИ ведёт свой блокнот в лорбуке; расширение предоставляет ему средства.
 *
 * Увидели <memory> в ответе — разобрали, дописали в лорбук, пересобрали оглавление,
 * вырезали блок из видимого текста. Уведомлений нет никому: это память ИИ,
 * а не человека. Диагностика — только в консоль.
 */

import { getStringHash } from '../../../utils.js';
import { MODULE_NAME, LOG_PREFIX, getSettings, saveSettings, log } from './src/settings.js';
import { extractBlocks, extractCommands } from './src/parse.js';
import { parseNotebook, renderNotebook, appendRecord, resolveRefine, formatDate } from './src/notebook.js';
import { resolveWorld, readNotebook, writeNotebook, describeProblem } from './src/lorebook.js';
import { buildInjection, runQuery } from './src/delivery.js';

const EXTENSION_PATH = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/');

const fingerprint = (s) => String(getStringHash(String(s)));

/** Последний результат работы — показывается только в панели настроек. */
let lastStatus = 'ещё не было записей';
function setPanelStatus(text) {
    lastStatus = text;
    const el = document.getElementById('am_status');
    if (el) el.textContent = text;
}

// ─── Доставка в контекст ─────────────────────────────────────────────

/** Глубина вставки инъекции: за четыре сообщения от конца, системной ролью. */
const INJECTION_DEPTH = 4;

/** Тип текущей генерации — чтобы фильтр не пускал память в тихие прогоны. */
let currentGenType = 'normal';
/** Последняя команда выборки от ИИ; результат уезжает со следующей генерацией. */
let lastQuery = null;
const injectionFilter = () => currentGenType !== 'quiet' && currentGenType !== 'impersonate';

function inject(text) {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        // scan=false: наш текст не должен триггерить чужие записи World Info;
        // filter отсекает тихие генерации даже для уже выставленной инъекции
        setExtensionPrompt(MODULE_NAME, text || '', 1, INJECTION_DEPTH, false, 0, injectionFilter);
    } catch (e) {
        log('не удалось выставить инъекцию:', e);
    }
}

/** Перед каждой генерацией собирает и вкладывает оглавление, ядро и записи по ключам. */
async function onGenerationStarted(type, _params, dryRun) {
    currentGenType = type || 'normal';
    if (dryRun) return;
    if (type === 'quiet' || type === 'impersonate') return;

    const s = getSettings();
    if (!s.enabled) return inject('');

    const ctx = SillyTavern.getContext();
    // characterId к этому моменту указывает на говорящего и в группе:
    // setCharacterId(chId) в group-chats.js вызывается до генерации участника
    const { world, problem } = resolveWorld(ctx, -1);
    if (problem) return inject('');

    const { content, problem: p2 } = await readNotebook(ctx, world, s.lorebookName);
    if (p2) return inject('');

    const recentText = (ctx.chat ?? [])
        .slice(-Math.max(1, Number(s.scanDepth) || 2))
        .map(m => String(m?.mes ?? ''))
        .join('\n')
        .toLowerCase();

    const coreCategories = String(s.coreCategories ?? '').split(',');
    const base = buildInjection(content, { coreCategories, recentText });
    const queryResult = lastQuery === null ? '' : runQuery(content, lastQuery);
    // весь лорбук уже содержит оглавление — не дублируем его
    inject(queryResult.startsWith('[INDEX]') ? queryResult
        : [base, queryResult].filter(Boolean).join('\n'));
}

// ─── Обработка сообщения ─────────────────────────────────────────────

async function onMessageReceived(messageIndex) {
    const s = getSettings();
    if (!s.enabled) return;

    const ctx = SillyTavern.getContext();
    const msg = ctx.chat?.[messageIndex];
    if (!msg || msg.is_user || msg.is_system) return;

    const text = String(msg.mes ?? '');
    if (!/<memory>/i.test(text) && !/^[ \t]*\/note_show\b/im.test(text)) return;

    // Свайп и правка дают новый текст на том же индексе — сверяем отпечаток исходного
    const mark = fingerprint(text);
    msg.extra = msg.extra || {};
    if (msg.extra[MODULE_NAME] === mark) { log('уже обработано'); return; }

    const blocks = extractBlocks(text);
    const commands = extractCommands(blocks.stripped);
    if (commands.queries.length) {
        lastQuery = commands.queries[commands.queries.length - 1];
        log('запрошена выборка:', lastQuery || '(весь лорбук)');
    }
    const { items, unclosed } = blocks;
    const stripped = commands.stripped;

    // Оборванный стримом блок без </memory>: срезаем его, запись не сохраняется
    let visible = stripped;
    let truncatedNote = '';
    if (unclosed !== -1) {
        visible = stripped.slice(0, unclosed).replace(/[ \t]*\n?$/, '');
        truncatedNote = 'блок оборван — эта запись не сохранена';
    }

    const good = items.filter(i => i.record);
    const bad = items.filter(i => i.error);
    const onlyCommands = !good.length && !bad.length && !truncatedNote;
    if (onlyCommands && !commands.queries.length) return;

    // Блок — служебная разметка, в сообщении ей не место при любом исходе
    const cleanup = () => {
        msg.mes = visible;
        msg.extra[MODULE_NAME] = mark;
        syncSwipe(msg);
        redraw(ctx, messageIndex, msg);
    };

    // Нечего сохранять — к лорбуку не ходим, пустая перезапись никому не нужна
    if (onlyCommands) { cleanup(); return; }
    if (!good.length) {
        cleanup();
        return report([], bad, [], truncatedNote);
    }

    // Куда писать: мир из карточки, лорбук по названию из настроек
    const { world, problem: worldProblem } = resolveWorld(ctx, messageIndex);
    if (worldProblem) {
        cleanup();
        return refuse(describeProblem(worldProblem, world, s.lorebookName));
    }

    const { data, entry, content, problem } = await readNotebook(ctx, world, s.lorebookName);
    if (problem) {
        cleanup();
        return refuse(describeProblem(problem, world, s.lorebookName));
    }

    // Пишем
    const model = parseNotebook(content);
    const today = formatDate();
    const written = [];
    const lost = [];

    for (const item of good) {
        const rec = item.record;
        rec.date = today;
        // «Уточняет» разрешаем по нумерации ДО пересчёта
        if (!resolveRefine(model, rec)) lost.push(rec.category || 'без категории');
        appendRecord(model, rec);
        written.push(rec);
    }

    const next = renderNotebook(model, today);

    try {
        await writeNotebook(ctx, world, data, entry, next);
    } catch (e) {
        console.error(LOG_PREFIX, 'не удалось сохранить лорбук:', e);
        cleanup();
        return refuse('не удалось сохранить лорбук');
    }

    cleanup();
    report(written, bad, lost, truncatedNote);
}

/** Ничего не сохранили. Блок из сообщения всё равно убран. Никаких уведомлений:
 * это память ИИ, а не человека. Причина — только в консоль, для диагностики. */
function refuse(reason) {
    setPanelStatus('запись не сохранена: ' + reason);
    console.warn(LOG_PREFIX, 'запись не сохранена:', reason);
}

function report(written, bad, lost, truncatedNote = '') {
    const parts = [];
    for (const rec of written) {
        const where = rec.category ? `в [${rec.category}]` : 'без категории';
        parts.push(rec.startLine ? `записано ${where}, строка ${rec.startLine}` : `записано ${where}`);
    }
    for (const item of bad) parts.push(`блок пропущен: ${item.error}`);
    for (const cat of lost) parts.push(`в записи (${cat}) не найдена строка для «Уточняет» — отметка снята`);
    if (truncatedNote) parts.push(truncatedNote);

    setPanelStatus(parts.join('; '));
    log('готово:', parts.join('; '));
}

/**
 * При потоковой генерации свайпа таверна кладёт сырой текст в msg.swipes[] до того,
 * как мы вырежем блок. Без синхронизации свайп туда-обратно вернёт блок и задвоит запись.
 */
function syncSwipe(msg) {
    const i = msg.swipe_id;
    if (!Array.isArray(msg.swipes) || typeof i !== 'number' || typeof msg.swipes[i] !== 'string') return;
    msg.swipes[i] = msg.mes;
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[i]) {
        msg.swipe_info[i].extra = structuredClone(msg.extra);
    }
}

function redraw(ctx, messageIndex, msg) {
    try {
        if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(messageIndex, msg);
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
    } catch (e) {
        log('перерисовка не удалась:', e);
    }
}

// ─── Панель настроек ─────────────────────────────────────────────────

function bindUI() {
    const el = document.getElementById('am_enabled');
    if (el) {
        el.addEventListener('change', (e) => {
            getSettings().enabled = e.target.checked;
            saveSettings();
        });
    }
    const dbg = document.getElementById('am_debug');
    if (dbg) {
        dbg.addEventListener('change', (e) => {
            getSettings().debug = e.target.checked;
            saveSettings();
        });
    }
    const name = document.getElementById('am_lorebook_name');
    if (name) {
        name.addEventListener('input', (e) => {
            getSettings().lorebookName = e.target.value;
            saveSettings();
        });
    }
    const core = document.getElementById('am_core_categories');
    if (core) {
        core.addEventListener('input', (e) => {
            getSettings().coreCategories = e.target.value;
            saveSettings();
        });
    }
    const depth = document.getElementById('am_scan_depth');
    if (depth) {
        depth.addEventListener('input', (e) => {
            getSettings().scanDepth = Math.max(1, Number(e.target.value) || 2);
            saveSettings();
        });
    }
}

function updateUI() {
    const s = getSettings();
    const el = document.getElementById('am_enabled');
    const dbg = document.getElementById('am_debug');
    const name = document.getElementById('am_lorebook_name');
    const core = document.getElementById('am_core_categories');
    const depth = document.getElementById('am_scan_depth');
    if (el) el.checked = s.enabled;
    if (dbg) dbg.checked = s.debug;
    if (name) name.value = s.lorebookName;
    if (core) core.value = s.coreCategories;
    if (depth) depth.value = s.scanDepth;
    const st = document.getElementById('am_status');
    if (st) st.textContent = lastStatus;
}

// ─── Запуск ──────────────────────────────────────────────────────────

(async function init() {
    const ctx = SillyTavern.getContext();
    const { eventSource, event_types, renderExtensionTemplateAsync } = ctx;

    getSettings();

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings', {});
        document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
        bindUI();
    } catch (e) {
        console.warn(LOG_PREFIX, 'панель настроек не загрузилась:', e);
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, () => { lastQuery = null; inject(''); });

    eventSource.on(event_types.APP_READY, () => {
        updateUI();
        console.log(LOG_PREFIX, 'загружено:', EXTENSION_PATH);
    });
})();
