/**
 * Общие регулярки формата. Единственная копия: разбор блока от ИИ (parse.js)
 * и разбор хранимого текста (notebook.js) обязаны понимать формат одинаково.
 */

/** Поле в шапке записи: ключ одним словом, иначе фраза с двоеточием стала бы полем */
export const RE_FIELD = /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]{0,23}):[ \t]?(.*)$/;

/** Строка тела с меткой: #тег(пояснение) текст. Группы: 1 тег, 2 пояснение, 3 текст */
export const RE_TAGGED = /^#([^\s(]+)(?:\(([^)]*)\))?[ \t]+(.*)$/;

/** Теги в хвосте маркера: #тег(пояснение), глобальная */
export const RE_TAG_G = /#([^\s(]+)(?:\(([^)]*)\))?/g;

/** [КАТЕГОРИЯ](пояснение) в начале маркера */
export const RE_CATEGORY = /^\[([^\]]+)\](?:\(([^)]*)\))?/;

/**
 * Разбирает хвост маркера: теги с необязательными пояснениями.
 * Тег приводится к нижнему регистру — иначе #Anchor и #anchor разойдутся в оглавлении.
 * @returns {{tags: string[], descriptions: Object<string,string>}}
 */
export function parseMarkerTags(tail) {
    const tags = [];
    const descriptions = {};
    RE_TAG_G.lastIndex = 0;
    let m;
    while ((m = RE_TAG_G.exec(String(tail ?? ''))) !== null) {
        const name = m[1].toLowerCase();
        if (!tags.includes(name)) tags.push(name);
        if (m[2] && m[2].trim()) descriptions[name] = m[2].trim();
    }
    return { tags, descriptions };
}
