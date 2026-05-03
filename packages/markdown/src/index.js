"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentFromMarkdown = contentFromMarkdown;
var core_1 = require("@plim/core");
function contentFromMarkdown() {
    var parts = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        parts[_i] = arguments[_i];
    }
    var source = parts.join('\n');
    var lines = source.split(/\r?\n/);
    var blocks = [];
    var title = 'Untitled';
    for (var _a = 0, lines_1 = lines; _a < lines_1.length; _a++) {
        var line = lines_1[_a];
        if (line.trim() === '') {
            continue;
        }
        var parsed = parseLine(line);
        if (blocks.length === 0 && parsed.type === 'heading1') {
            title = parsed.text;
            continue;
        }
        var inline = parseInlineMarks(parsed.text);
        blocks.push((0, core_1.createBlock)(parsed.type, inline.text, { marks: inline.marks }));
    }
    return (0, core_1.createContent)(blocks.length > 0 ? blocks : [(0, core_1.createBlock)('paragraph', '')], title);
}
function parseLine(line) {
    var trimmed = line.trim();
    if (trimmed === '---' || trimmed === '***') {
        return { type: 'divider', text: '' };
    }
    if (trimmed.startsWith('### ')) {
        return { type: 'heading3', text: trimmed.slice(4) };
    }
    if (trimmed.startsWith('## ')) {
        return { type: 'heading2', text: trimmed.slice(3) };
    }
    if (trimmed.startsWith('# ')) {
        return { type: 'heading1', text: trimmed.slice(2) };
    }
    if (/^[-*+]\s+/.test(trimmed)) {
        return { type: 'bulletedList', text: trimmed.replace(/^[-*+]\s+/, '') };
    }
    if (/^\d+\.\s+/.test(trimmed)) {
        return { type: 'numberedList', text: trimmed.replace(/^\d+\.\s+/, '') };
    }
    if (trimmed.startsWith('> ')) {
        return { type: 'quote', text: trimmed.slice(2) };
    }
    if (/^\[[ xX]\]\s+/.test(trimmed)) {
        return { type: 'todo', text: trimmed.replace(/^\[[ xX]\]\s+/, '') };
    }
    return { type: 'paragraph', text: line };
}
function parseInlineMarks(input) {
    var _a, _b, _c, _d;
    var marks = [];
    var output = '';
    var cursor = 0;
    var pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|~([^~]+)~|\*([^*]+)\*)/g;
    var match;
    while ((match = pattern.exec(input))) {
        output += input.slice(cursor, match.index);
        var start = output.length;
        var text = (_d = (_c = (_b = (_a = match[2]) !== null && _a !== void 0 ? _a : match[3]) !== null && _b !== void 0 ? _b : match[4]) !== null && _c !== void 0 ? _c : match[5]) !== null && _d !== void 0 ? _d : '';
        output += text;
        var end = output.length;
        var mark = match[2] ? 'bold' : match[3] ? 'code' : match[4] ? 'strikethrough' : 'italic';
        marks.push({ mark: mark, from: start, to: end });
        cursor = match.index + match[0].length;
    }
    output += input.slice(cursor);
    return { text: output, marks: marks };
}
