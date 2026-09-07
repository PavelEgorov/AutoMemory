/**
 * Подключённая ИИ: та, что разбирает текст и ведёт блокнот.
 * Это не собеседник в чате, а отдельный запрос — через профиль подключения
 * или через основное подключение таверны.
 */

import { getSettings, warn } from './settings.js';

/** Достать текст из ответа: форма зависит от вида подключения. */
function extractText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw.content === 'string') return raw.content;
    if (typeof raw.message?.content === 'string') return raw.message.content;
    const choice = raw.choices?.[0];
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    if (typeof choice?.text === 'string') return choice.text;
    return '';
}

/** Человеческое название текущего источника подключения — для панели. */
export function sourceName() {
    const s = getSettings();
    if (s.connectionSource !== 'profile') return 'основное подключение таверны';
    if (!s.connectionProfileId) return 'профиль не выбран';
    try {
        const profiles = SillyTavern.getContext().extensionSettings?.connectionManager?.profiles || [];
        const found = profiles.find(p => p.id === s.connectionProfileId);
        return found ? `профиль «${found.name}»` : 'профиль не найден';
    } catch (e) {
        return 'профиль подключения';
    }
}

/**
 * Спросить подключённую ИИ.
 * @param {string} userPrompt текст запроса
 * @param {string} [systemPrompt] системный промт; по умолчанию из настроек
 * @returns {Promise<string>} ответ текстом
 */
export async function ask(userPrompt, systemPrompt) {
    const s = getSettings();
    const system = systemPrompt ?? s.systemPrompt;
    const ctx = SillyTavern.getContext();

    if (s.connectionSource === 'profile') {
        if (!s.connectionProfileId) {
            throw new Error('профиль подключения не выбран');
        }
        const service = ctx.ConnectionManagerRequestService;
        if (!service?.sendRequest) {
            throw new Error('менеджер подключений недоступен');
        }
        // Второй аргумент — массив сообщений либо строка: так ждёт текущая таверна.
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
        ];
        const raw = await service.sendRequest(s.connectionProfileId, messages, s.maxTokens);
        return extractText(raw);
    }

    if (!ctx.generateRaw) {
        throw new Error('основное подключение недоступно');
    }
    const raw = await ctx.generateRaw({
        prompt: userPrompt,
        systemPrompt: system,
        responseLength: s.maxTokens,
    });
    return extractText(raw);
}

/**
 * Проверить подключение коротким запросом.
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function testConnection() {
    try {
        const answer = await ask(
            'Ответь одним словом: готов',
            'Ты отвечаешь коротко и по делу.',
        );
        const text = String(answer || '').trim();
        if (!text) return { ok: false, reason: 'ответ пришёл пустым' };
        return { ok: true, reason: `ответ получен: «${text.slice(0, 60)}»` };
    } catch (e) {
        warn('проверка подключения не удалась:', e);
        return { ok: false, reason: String(e?.message || e) };
    }
}
