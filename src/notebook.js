/**
 * Резка блокнота.
 *
 * Раньше формат блокнота знала только ИИ расширения, а расширение возило текст
 * целиком. Из-за этого весь блокнот уезжал в каждый запрос и упирался в потолок
 * ответа. По решению человека резать теперь умеет расширение: оно делит блокнот
 * на оглавление и блоки, отдаёт ИИ только нужные и собирает документ обратно.
 *
 * Формат из постановки: разделы отделены строкой из трёх дефисов, первый раздел —
 * оглавление со строкой [List of tags] и нумерованными тегами, дальше по разделу
 * на тег, первая строка раздела — номер и тег.
 *
 * Смысла текста расширение по-прежнему не разбирает: оно видит границы разделов
 * и имена тегов, не более того.
 */

const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/;
const INDEX_MARK = '[List of tags]';

/** Имя тега в строке: решётка и всё до пробела или следующей решётки. */
function tagIn(line) {
    const found = String(line ?? '').match(/#[^\s#]+/);
    return found ? found[0] : '';
}

/**
 * Разрезать блокнот на оглавление и блоки.
 * @returns {{index: string, blocks: {tag: string, text: string}[]}}
 */
export function split(text) {
    const sections = String(text ?? '')
        .split('\n')
        .reduce((acc, line) => {
            if (SEPARATOR.test(line)) acc.push([]);
            else acc[acc.length - 1].push(line);
            return acc;
        }, [[]])
        .map(lines => lines.join('\n').trim())
        .filter(Boolean);

    let index = '';
    const blocks = [];
    for (const section of sections) {
        if (!index && section.includes(INDEX_MARK)) {
            index = section;
            continue;
        }
        const tag = tagIn(section.split('\n')[0]);
        if (tag) blocks.push({ tag, text: section });
    }
    return { index, blocks };
}

/** Теги, перечисленные в оглавлении, по порядку. */
export function tagsOf(index) {
    const tags = [];
    for (const line of String(index ?? '').split('\n')) {
        if (line.includes(INDEX_MARK)) continue;
        const tag = tagIn(line);
        if (tag && !tags.includes(tag)) tags.push(tag);
    }
    return tags;
}

/**
 * Какие из известных тегов упомянуты в этих кусках текста.
 * Ищутся именно известные имена — грамматику команды расширение не разбирает.
 */
export function mentioned(tags, fragments) {
    const haystack = (Array.isArray(fragments) ? fragments : [fragments]).join('\n');
    return (tags || []).filter(tag => haystack.includes(tag));
}

/** Блоки названных тегов, в порядке самих блоков. */
export function pick(blocks, tags) {
    const wanted = new Set(tags || []);
    return (blocks || []).filter(b => wanted.has(b.tag));
}

/** Склеить блоки в один кусок через разделитель — так они уезжают к ИИ. */
export function joinBlocks(blocks) {
    return (blocks || []).map(b => b.text).join('\n---\n');
}

/** Оглавление по списку блоков: номера идут за порядком блоков. */
export function buildIndex(blocks) {
    const lines = [INDEX_MARK];
    (blocks || []).forEach((b, i) => lines.push(`${i + 1}.${b.tag}`));
    return lines.join('\n');
}

/**
 * Влить возвращённые блоки в имеющиеся: тег уже есть — блок заменяется,
 * нет — дописывается в конец. Порядок прежних блоков сохраняется.
 */
export function merge(blocks, incoming) {
    const result = (blocks || []).map(b => ({ ...b }));
    for (const block of incoming || []) {
        const found = result.find(b => b.tag === block.tag);
        if (found) found.text = block.text;
        else result.push({ ...block });
    }
    return result;
}

/** Собрать документ обратно: оглавление и блоки через разделитель. */
export function render(blocks, index) {
    const parts = [index || buildIndex(blocks), ...(blocks || []).map(b => b.text)];
    return ['', ...parts, ''].join('\n---\n').trim();
}
