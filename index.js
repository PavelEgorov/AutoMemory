/**
 * AutoMemory — ИИ ведёт свой блокнот в лорбуке; расширение предоставляет ему средства.
 *
 * Увидели <memory> в ответе — разобрали, дописали в лорбук, пересобрали оглавление,
 * вырезали блок из видимого текста. Уведомлений нет никому: это память ИИ,
 * а не человека. Диагностика — только в консоль.
 */

import { getStringHash } from '../../../utils.js';
import { MODULE_NAME, LOG_PREFIX, getSettings, saveSettings, log } from './src/settings.js';
import { extractBlocks } from './src/parse.js';
import { parseNotebook, renderNotebook, appendRecord, resolveRefine } from './src/notebook.js';
import { resolveTarget, resolveCharacter, charExtraWorlds, bindingOf, bindingSnapshot, readNotebook, writeNotebook, describeProblem } from './src/lorebook.js';
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
    const t = resolveTarget(ctx, -1, s.bindings);
    if (t.problem) return inject('');

    const { content, problem: p2 } = await readNotebook(ctx, t.world, t.lorebook);
    if (p2) return inject('');

    const recentText = (ctx.chat ?? [])
        .slice(-Math.max(1, Number(s.scanDepth) || 2))
        .map(m => String(m?.mes ?? ''))
        .join(String.fromCharCode(10))
        .toLowerCase();

    const coreCategories = String(s.coreCategories ?? '').split(',');
    inject(buildInjection(content, { coreCategories, recentText }));
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

    const { items, stripped, unclosed } = extractBlocks(text);

    // Оборванный стримом блок без </memory>: срезаем его, запись не сохраняется
    let visible = stripped;
    let truncatedNote = '';
    if (unclosed !== -1) {
        visible = stripped.slice(0, unclosed).replace(/[ \t]*\n?$/, '');
        truncatedNote = 'блок оборван — эта запись не сохранена';
    }

    const good = items.filter(i => i.record);
    const bad = items.filter(i => i.error);
    if (!good.length && !bad.length && !truncatedNote) return;

    // Блок — служебная разметка; вырезается, если человек не попросил оставлять
    const cleanup = () => {
        msg.extra[MODULE_NAME] = mark;
        if (s.keepBlocks) return;
        msg.mes = visible;
        syncSwipe(msg);
        redraw(ctx, messageIndex, msg);
    };

    // Нечего сохранять — к лорбуку не ходим, пустая перезапись никому не нужна
    if (!good.length) {
        cleanup();
        return report([], bad, [], truncatedNote);
    }

    // Куда писать: связка персонаж → мир → лорбук из таблицы настроек
    const t = resolveTarget(ctx, messageIndex, s.bindings);
    if (t.problem) {
        cleanup();
        return refuse(describeProblem(t.problem, t.character?.name ?? '?', ''));
    }

    const nb = await readNotebook(ctx, t.world, t.lorebook);
    if (nb.problem) {
        cleanup();
        return refuse(describeProblem(nb.problem, t.world, t.lorebook));
    }
    const { data, entry, content } = nb;

    // Пишем
    const model = parseNotebook(content);
    const written = [];
    const lost = [];

    for (const item of good) {
        const rec = item.record;
        // «Уточняет» разрешаем по нумерации ДО пересчёта
        if (!resolveRefine(model, rec)) lost.push(rec.category || 'без категории');
        appendRecord(model, rec);
        written.push(rec);
    }

    const next = renderNotebook(model);

    try {
        await writeNotebook(ctx, t.world, data, entry, next);
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

// ─── Скрытие своих вызовов инструмента из чата ───────────────────────

/**
 * Таверна после каждого вызова кладёт в чат системное сообщение с результатом.
 * Наши вызовы note_show — служебная кухня: убираем их сообщение сразу после
 * отрисовки, пока оно не сохранилось и не уехало в промпт следующих ходов.
 * Галка «Не вырезать» оставляет их видимыми — как и блоки.
 */
function onToolCallsRendered(invocations) {
    try {
        const s = getSettings();
        if (!s.enabled || s.keepBlocks) return;
        if (!Array.isArray(invocations) || !invocations.length) return;
        if (!invocations.every(inv => inv?.name === 'note_show')) return;

        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        const last = chat?.[chat.length - 1];
        if (!last?.is_system || !Array.isArray(last?.extra?.tool_invocations)) return;

        const mesId = chat.length - 1;
        chat.pop(); // до saveChatConditional — сообщение не попадёт ни в файл, ни в промпт
        document.querySelector(`#chat .mes[mesid="${mesId}"]`)?.remove();
        log('сообщение о вызове note_show убрано из чата');
    } catch (e) {
        log('не удалось убрать сообщение о вызове:', e);
    }
}

// ─── Экономное продолжение после note_show ───────────────────────────

/** Сколько последних сообщений диалога остаётся во втором проходе. */
const TRIM_KEEP = 6;

/**
 * Второй проход после вызова инструмента везёт весь промпт заново — цена механизма:
 * у модели нет памяти между запросами, дослать токены в идущую генерацию нельзя.
 * С галкой «экономное продолжение» режем повтор перед самой отправкой: остаются
 * системные части (карточка, инструкции, наша инъекция), хвост диалога и сам вызов
 * с результатом. Пары «вызов → результат» не рвём — API требует их вместе.
 */
function onPromptReady(eventData) {
    try {
        const s = getSettings();
        if (!s.enabled || !s.trimToolPass || eventData?.dryRun) return;
        const chat = eventData?.chat;
        if (!Array.isArray(chat)) return;

        const callMsgs = chat.filter(m => Array.isArray(m?.tool_calls));
        if (!callMsgs.length) return;
        // режем только свои вызовы: чужие инструменты — не наше дело
        if (!callMsgs.every(m => m.tool_calls.every(tc => tc?.function?.name === 'note_show'))) return;

        const firstTool = chat.findIndex(m => Array.isArray(m?.tool_calls) || m?.role === 'tool');
        const head = chat.slice(0, firstTool);
        const toolChain = chat.slice(firstTool);
        const systems = head.filter(m => m?.role === 'system');
        const dialog = head.filter(m => m?.role !== 'system');
        if (dialog.length <= TRIM_KEEP) return;

        // хвост диалога; тянем вверх до реплики человека, чтобы не начинать с ответа
        let from = dialog.length - TRIM_KEEP;
        while (from > 0 && dialog[from]?.role !== 'user' && dialog.length - from < TRIM_KEEP + 4) from--;

        const before = chat.length;
        chat.length = 0;
        chat.push(...systems, ...dialog.slice(from), ...toolChain);
        log('экономное продолжение: сообщений', before, '->', chat.length);
    } catch (e) {
        log('экономное продолжение не удалось:', e);
    }
}

// ─── Инструмент note_show ────────────────────────────────────────────

/**
 * Регистрирует вызов инструмента: модель запрашивает выборку посреди генерации
 * и сразу получает результат. Текстовой команды нет — только этот путь.
 */
function registerNoteTool(ctx) {
    if (typeof ctx.registerFunctionTool !== 'function') {
        console.warn(LOG_PREFIX, 'registerFunctionTool недоступен — выборка работать не будет');
        return;
    }
    ctx.registerFunctionTool({
        name: 'note_show',
        displayName: 'Блокнот',
        description: 'Твой блокнот — долговременная память в лорбуке. Возвращает записи по фильтру. ' +
            'Фильтр: категория (например ANALYTICS_NEK) и/или тег с решёткой (#spiral); ' +
            'вместе работают как И: «META #spiral». Слово «оглавление» — только оглавление. ' +
            'Пустой фильтр — весь блокнот целиком.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                filter: {
                    type: 'string',
                    description: 'Фильтр выборки; пустая строка — весь блокнот',
                },
            },
            required: [],
        },
        action: async (args) => {
            const s = getSettings();
            if (!s.enabled) return 'AutoMemory выключено.';

            const c = SillyTavern.getContext();
            const t = resolveTarget(c, -1, s.bindings);
            if (t.problem) return 'Блокнот недоступен: ' + describeProblem(t.problem, t.character?.name ?? '?', '');

            const nb = await readNotebook(c, t.world, t.lorebook);
            if (nb.problem) return 'Блокнот недоступен: ' + describeProblem(nb.problem, t.world, t.lorebook);

            const result = runQuery(nb.content, args?.filter ?? '');
            log('note_show:', args?.filter || '(весь блокнот)', '->', result.length, 'симв.');
            return result || 'По этому фильтру записей нет.';
        },
        shouldRegister: () => getSettings().enabled,
        stealth: false,
    });
    log('инструмент note_show зарегистрирован');
}

/** Диагностика связки по кнопке: персонаж → миры → лорбук. Печатает в панель. */
async function runDiagnostics() {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const out = [];
    try {
        const character = resolveCharacter(ctx, -1);
        if (!character) {
            out.push('персонаж: НЕ ОПРЕДЕЛЁН (characterId=' + String(ctx.characterId) + ')');
        } else {
            out.push('персонаж: ' + String(character.name) + ' (' + String(character.avatar) + ')');
            if (String(character.avatar).startsWith('default_Assistant')) {
                out.push('⚠ это встроенный Ассистент таверны. Кнопка смотрит на персонажа');
                out.push('открытого чата — открой чат со своей карточкой и нажми снова,');
                out.push('либо привяжи мир к самому Ассистенту (глобус на его карточке).');
            }
            out.push('основной мир в карточке: ' + (character.data?.extensions?.world || '— пусто —'));
            const extra = charExtraWorlds(character);
            out.push('дополнительные миры: ' + (extra.length ? extra.join(', ') : '— нет —'));
            const bnd = bindingOf(s.bindings, character.avatar);
            out.push('связка из таблицы: ' + (bnd ? (bnd.world || '?') + ' / ' + (bnd.lorebook || '?') : '— нет —'));
            for (const line of bindingSnapshot(ctx, character)) out.push(line);
            if (character.data?.character_book) out.push('встроенный в карточку мир: есть (не файл World Info)');
        }
        const known = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
        out.push('миров в системе: ' + known.length + (known.length ? ' — ' + known.slice(0, 6).join(', ') : ''));

        const t = resolveTarget(ctx, -1, s.bindings);
        if (t.problem) {
            out.push('итог: ' + describeProblem(t.problem, character?.name ?? '?', ''));
            setPanelStatus(out.join(String.fromCharCode(10)));
            return;
        }
        out.push('цель: мир «' + t.world + '», лорбук «' + t.lorebook + '»');
        const nb = await readNotebook(ctx, t.world, t.lorebook);
        if (nb.problem) {
            out.push('итог: ' + describeProblem(nb.problem, t.world, t.lorebook));
            const d = await ctx.loadWorldInfo(t.world);
            const names = Object.values(d?.entries ?? {}).filter(Boolean)
                .map(e => String(e.comment ?? '').trim() || '(без названия)');
            out.push('записи в «' + t.world + '»: ' + (names.length ? names.join(' | ') : '— пусто —'));
        } else {
            out.push('итог: лорбук найден в «' + t.world + '», '
                + (nb.content.trim() ? 'есть содержимое' : 'пуст, готов к первой записи'));
        }
    } catch (e) {
        out.push('ошибка диагностики: ' + String(e?.message ?? e));
    }
    setPanelStatus(out.join(String.fromCharCode(10)));
}

// ─── Таблица связок персонаж → мир → лорбук ──────────────────────────

function renderBindings() {
    const box = document.getElementById('am_bindings');
    if (!box) return;
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chars = Array.isArray(ctx.characters) ? ctx.characters : [];
    const nameOf = (avatar) => chars.find(c => c?.avatar === avatar)?.name ?? avatar;
    const current = resolveCharacter(ctx, -1);

    box.textContent = '';
    for (const [avatar, raw] of Object.entries(s.bindings ?? {})) {
        const b = typeof raw === 'string' ? { world: raw, lorebook: '' } : raw;
        const row = document.createElement('div');
        row.className = 'am-bind-row';
        if (current && (avatar === current.avatar || avatar === current.name)) {
            row.classList.add('am-bind-current');
            row.title = 'текущий персонаж';
        }
        const label = document.createElement('span');
        if (b.world && b.lorebook) {
            label.textContent = nameOf(avatar) + ' → ' + b.world + ' / ' + b.lorebook;
        } else {
            label.textContent = '⚠ ' + nameOf(avatar) + ' → связка неполная, добавьте заново';
        }
        const del = document.createElement('button');
        del.className = 'menu_button am-bind-del';
        del.textContent = '✕';
        del.addEventListener('click', () => {
            delete getSettings().bindings[avatar];
            saveSettings();
            renderBindings();
        });
        row.append(label, del);
        box.append(row);
    }

    const charSel = document.getElementById('am_bind_char');
    const worldSel = document.getElementById('am_bind_world');
    if (charSel && worldSel) {
        charSel.textContent = '';
        for (const c of chars) {
            if (!c?.avatar) continue;
            // цветом option в системном списке Android не выделить — метим текстом
            const isCur = current && c.avatar === current.avatar;
            const label = (isCur ? '★ ' : '') + (c.name ?? c.avatar) + (isCur ? ' — текущий' : '');
            const opt = new Option(label, c.avatar);
            if (isCur) opt.selected = true;
            charSel.append(opt);
        }
        worldSel.textContent = '';
        worldSel.append(new Option('— мир —', ''));
        const worlds = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
        for (const w of worlds) worldSel.append(new Option(w, w));
        fillLorebookSelect('');
    }
}

/** Третья колонка: записи выбранного в этой строке мира. */
async function fillLorebookSelect(world) {
    const sel = document.getElementById('am_bind_lorebook');
    if (!sel) return;
    sel.textContent = '';
    if (!world) {
        sel.append(new Option('— сначала мир —', ''));
        return;
    }
    try {
        const ctx = SillyTavern.getContext();
        const data = await ctx.loadWorldInfo(world);
        const names = Object.values(data?.entries ?? {}).filter(Boolean)
            .map(e => String(e.comment ?? '').trim())
            .filter(Boolean);
        if (!names.length) {
            sel.append(new Option('— в мире нет записей —', ''));
            return;
        }
        sel.append(new Option('— лорбук —', ''));
        for (const n of names) sel.append(new Option(n, n));
    } catch (e) {
        log('не удалось прочитать мир для списка лорбуков:', e);
        sel.append(new Option('— мир не прочитался —', ''));
    }
}

function bindBindingsUI() {
    const worldSel = document.getElementById('am_bind_world');
    if (worldSel) worldSel.addEventListener('change', (e) => fillLorebookSelect(e.target.value));
    const addBtn = document.getElementById('am_bind_add');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => {
        const charSel = document.getElementById('am_bind_char');
        const avatar = charSel?.value;
        const world = document.getElementById('am_bind_world')?.value;
        const lorebook = document.getElementById('am_bind_lorebook')?.value;
        if (!avatar) return setPanelStatus('связка не сохранена: не выбран персонаж');
        if (!world) return setPanelStatus('связка не сохранена: не выбран мир');
        if (!lorebook) return setPanelStatus('связка не сохранена: не выбран лорбук (третий список)');
        const s = getSettings();
        if (!s.bindings || typeof s.bindings !== 'object') s.bindings = {};
        // одна строка на персонажа: ключ — аватар, повторное «Добавить» перезаписывает;
        // заодно сносим устаревший ключ той же карточки по имени
        const ch = (SillyTavern.getContext().characters ?? []).find(c => c?.avatar === avatar);
        for (const k of Object.keys(s.bindings)) {
            if (k !== avatar && ch && k === ch.name) delete s.bindings[k];
        }
        s.bindings[avatar] = { world, lorebook };
        saveSettings();
        renderBindings();
        const charName = ch?.name ?? avatar;
        setPanelStatus('связка сохранена: ' + charName + ' → ' + world + ' / ' + lorebook);
    });
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
    const keep = document.getElementById('am_keep_blocks');
    if (keep) {
        keep.addEventListener('change', (e) => {
            getSettings().keepBlocks = e.target.checked;
            saveSettings();
        });
    }
    const trim = document.getElementById('am_trim_tool');
    if (trim) {
        trim.addEventListener('change', (e) => {
            getSettings().trimToolPass = e.target.checked;
            saveSettings();
        });
    }
    const chk = document.getElementById('am_check');
    if (chk) chk.addEventListener('click', runDiagnostics);
    bindBindingsUI();
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
    const core = document.getElementById('am_core_categories');
    const depth = document.getElementById('am_scan_depth');
    if (el) el.checked = s.enabled;
    if (dbg) dbg.checked = s.debug;
    if (core) core.value = s.coreCategories;
    if (depth) depth.value = s.scanDepth;
    const keep = document.getElementById('am_keep_blocks');
    if (keep) keep.checked = s.keepBlocks;
    const trim = document.getElementById('am_trim_tool');
    if (trim) trim.checked = s.trimToolPass;
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

    registerNoteTool(ctx);

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.TOOL_CALLS_RENDERED, onToolCallsRendered);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        inject('');
        renderBindings(); // подсветка текущего персонажа следует за открытым чатом
    });

    eventSource.on(event_types.APP_READY, () => {
        updateUI();
        renderBindings();
        console.log(LOG_PREFIX, 'загружено:', EXTENSION_PATH);
    });
})();
