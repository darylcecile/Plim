"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _HistoryController_instances, _HistoryController_past, _HistoryController_future, _HistoryController_listeners, _HistoryController_restore, _HistoryController_emit, _PlimDriver_instances, _PlimDriver_options, _PlimDriver_history, _PlimDriver_extensionCache, _PlimDriver_resolveExtensions;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Snapshot = exports.PlimDriver = exports.HistoryController = exports.triggerRuleBuilders = exports.triggers = void 0;
exports.defineAction = defineAction;
exports.defineBlock = defineBlock;
exports.defineMark = defineMark;
exports.defineExtension = defineExtension;
exports.createBlock = createBlock;
exports.createContent = createContent;
exports.cloneContent = cloneContent;
exports.cloneState = cloneState;
exports.cloneSelection = cloneSelection;
exports.evaluateTriggerRule = evaluateTriggerRule;
exports.triggerMatches = triggerMatches;
exports.operationApply = operationApply;
exports.createId = createId;
exports.triggers = {
    keyboard: {
        shortcut: function (shortcut) { return ({ kind: 'keyboard', mode: 'shortcut', value: shortcut }); },
        character: function (character) { return ({ kind: 'keyboard', mode: 'character', value: character }); },
        key: function (key) { return ({ kind: 'keyboard', mode: 'key', value: key }); }
    },
    clipboard: {
        action: function (action) { return ({ kind: 'clipboard', action: action }); }
    }
};
exports.triggerRuleBuilders = {
    and: function (rules) { return ({ kind: 'and', rules: rules }); },
    or: function (rules) { return ({ kind: 'or', rules: rules }); },
    not: function (rule) { return ({ kind: 'not', rule: rule }); }
};
function defineAction(name, config) {
    var _a;
    return __assign(__assign({}, config), { name: name, priority: (_a = config.priority) !== null && _a !== void 0 ? _a : 0 });
}
function defineBlock(definition) {
    return __assign({ type: 'standalone', nestable: false, supportsMarks: true }, definition);
}
function defineMark(definition) {
    return definition;
}
function defineExtension(setup) {
    return { kind: 'plim.extension', setup: setup };
}
var HistoryController = /** @class */ (function () {
    function HistoryController() {
        _HistoryController_instances.add(this);
        _HistoryController_past.set(this, []);
        _HistoryController_future.set(this, []);
        _HistoryController_listeners.set(this, new Set());
        _HistoryController_restore.set(this, null);
    }
    Object.defineProperty(HistoryController.prototype, "canUndo", {
        get: function () {
            return __classPrivateFieldGet(this, _HistoryController_past, "f").length > 0;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HistoryController.prototype, "canRedo", {
        get: function () {
            return __classPrivateFieldGet(this, _HistoryController_future, "f").length > 0;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HistoryController.prototype, "state", {
        get: function () {
            return {
                canUndo: this.canUndo,
                canRedo: this.canRedo,
                past: __spreadArray([], __classPrivateFieldGet(this, _HistoryController_past, "f"), true),
                future: __spreadArray([], __classPrivateFieldGet(this, _HistoryController_future, "f"), true)
            };
        },
        enumerable: false,
        configurable: true
    });
    HistoryController.prototype.attachRestore = function (restore) {
        __classPrivateFieldSet(this, _HistoryController_restore, restore, "f");
    };
    HistoryController.prototype.record = function (transaction) {
        __classPrivateFieldGet(this, _HistoryController_past, "f").push(transaction);
        __classPrivateFieldSet(this, _HistoryController_future, [], "f");
        __classPrivateFieldGet(this, _HistoryController_instances, "m", _HistoryController_emit).call(this);
    };
    HistoryController.prototype.undo = function () {
        if (!__classPrivateFieldGet(this, _HistoryController_restore, "f")) {
            throw new Error('Cannot undo before an editor is attached to history.');
        }
        var transaction = __classPrivateFieldGet(this, _HistoryController_past, "f").pop();
        if (!transaction) {
            return null;
        }
        __classPrivateFieldGet(this, _HistoryController_future, "f").push(transaction);
        __classPrivateFieldGet(this, _HistoryController_restore, "f").call(this, cloneState(transaction.before), transaction);
        __classPrivateFieldGet(this, _HistoryController_instances, "m", _HistoryController_emit).call(this);
        return transaction;
    };
    HistoryController.prototype.redo = function () {
        if (!__classPrivateFieldGet(this, _HistoryController_restore, "f")) {
            throw new Error('Cannot redo before an editor is attached to history.');
        }
        var transaction = __classPrivateFieldGet(this, _HistoryController_future, "f").pop();
        if (!transaction) {
            return null;
        }
        __classPrivateFieldGet(this, _HistoryController_past, "f").push(transaction);
        __classPrivateFieldGet(this, _HistoryController_restore, "f").call(this, cloneState(transaction.after), transaction);
        __classPrivateFieldGet(this, _HistoryController_instances, "m", _HistoryController_emit).call(this);
        return transaction;
    };
    HistoryController.prototype.onChange = function (listener) {
        var _this = this;
        __classPrivateFieldGet(this, _HistoryController_listeners, "f").add(listener);
        listener(this.state);
        return function () { return __classPrivateFieldGet(_this, _HistoryController_listeners, "f").delete(listener); };
    };
    return HistoryController;
}());
exports.HistoryController = HistoryController;
_HistoryController_past = new WeakMap(), _HistoryController_future = new WeakMap(), _HistoryController_listeners = new WeakMap(), _HistoryController_restore = new WeakMap(), _HistoryController_instances = new WeakSet(), _HistoryController_emit = function _HistoryController_emit() {
    var state = this.state;
    for (var _i = 0, _a = __classPrivateFieldGet(this, _HistoryController_listeners, "f"); _i < _a.length; _i++) {
        var listener = _a[_i];
        listener(state);
    }
};
var PlimDriver = /** @class */ (function () {
    function PlimDriver(options) {
        if (options === void 0) { options = {}; }
        var _a, _b, _c, _d, _e;
        _PlimDriver_instances.add(this);
        _PlimDriver_options.set(this, void 0);
        _PlimDriver_history.set(this, new HistoryController());
        _PlimDriver_extensionCache.set(this, new WeakMap());
        __classPrivateFieldSet(this, _PlimDriver_options, {
            theme: (_a = options.theme) !== null && _a !== void 0 ? _a : 'light',
            extensions: __spreadArray([], ((_b = options.extensions) !== null && _b !== void 0 ? _b : []), true),
            registeredMarks: __spreadArray([], ((_c = options.registeredMarks) !== null && _c !== void 0 ? _c : []), true),
            registeredBlocks: __spreadArray([], ((_d = options.registeredBlocks) !== null && _d !== void 0 ? _d : []), true),
            registeredActions: __spreadArray([], ((_e = options.registeredActions) !== null && _e !== void 0 ? _e : []), true)
        }, "f");
    }
    Object.defineProperty(PlimDriver.prototype, "theme", {
        get: function () {
            return __classPrivateFieldGet(this, _PlimDriver_options, "f").theme;
        },
        enumerable: false,
        configurable: true
    });
    PlimDriver.prototype.setTheme = function (theme) {
        __classPrivateFieldGet(this, _PlimDriver_options, "f").theme = theme;
    };
    PlimDriver.prototype.getHistory = function () {
        return __classPrivateFieldGet(this, _PlimDriver_history, "f");
    };
    PlimDriver.prototype.getRegisteredBlocks = function (editor) {
        return __spreadArray(__spreadArray([], __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredBlocks, true), __classPrivateFieldGet(this, _PlimDriver_instances, "m", _PlimDriver_resolveExtensions).call(this, editor).flatMap(function (extension) { var _a; return (_a = extension.registeredBlocks) !== null && _a !== void 0 ? _a : []; }), true);
    };
    PlimDriver.prototype.getRegisteredMarks = function (editor) {
        return __spreadArray(__spreadArray([], __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredMarks, true), __classPrivateFieldGet(this, _PlimDriver_instances, "m", _PlimDriver_resolveExtensions).call(this, editor).flatMap(function (extension) { var _a; return (_a = extension.registeredMarks) !== null && _a !== void 0 ? _a : []; }), true);
    };
    PlimDriver.prototype.getRegisteredActions = function (editor) {
        return __spreadArray(__spreadArray([], __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredActions, true), __classPrivateFieldGet(this, _PlimDriver_instances, "m", _PlimDriver_resolveExtensions).call(this, editor).flatMap(function (extension) { var _a; return (_a = extension.registeredActions) !== null && _a !== void 0 ? _a : []; }), true).sort(function (a, b) { return b.priority - a.priority; });
    };
    PlimDriver.prototype.getExtensions = function (editor) {
        return __classPrivateFieldGet(this, _PlimDriver_instances, "m", _PlimDriver_resolveExtensions).call(this, editor);
    };
    PlimDriver.prototype.configure = function (options) {
        var _a;
        if ('theme' in options) {
            __classPrivateFieldGet(this, _PlimDriver_options, "f").theme = (_a = options.theme) !== null && _a !== void 0 ? _a : 'light';
        }
        if (options.extensions) {
            __classPrivateFieldGet(this, _PlimDriver_options, "f").extensions = __spreadArray([], options.extensions, true);
        }
        if (options.registeredMarks) {
            __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredMarks = __spreadArray([], options.registeredMarks, true);
        }
        if (options.registeredBlocks) {
            __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredBlocks = __spreadArray([], options.registeredBlocks, true);
        }
        if (options.registeredActions) {
            __classPrivateFieldGet(this, _PlimDriver_options, "f").registeredActions = __spreadArray([], options.registeredActions, true);
        }
    };
    PlimDriver.prototype._recordTransaction = function (transaction) {
        __classPrivateFieldGet(this, _PlimDriver_history, "f").record(transaction);
    };
    return PlimDriver;
}());
exports.PlimDriver = PlimDriver;
_PlimDriver_options = new WeakMap(), _PlimDriver_history = new WeakMap(), _PlimDriver_extensionCache = new WeakMap(), _PlimDriver_instances = new WeakSet(), _PlimDriver_resolveExtensions = function _PlimDriver_resolveExtensions(editor) {
    var _this = this;
    return __classPrivateFieldGet(this, _PlimDriver_options, "f").extensions.map(function (extension) {
        var cached = __classPrivateFieldGet(_this, _PlimDriver_extensionCache, "f").get(extension);
        if (cached) {
            return cached;
        }
        if (!editor) {
            return {
                name: 'pending-extension'
            };
        }
        var resolved = extension.setup(editor);
        __classPrivateFieldGet(_this, _PlimDriver_extensionCache, "f").set(extension, resolved);
        return resolved;
    });
};
var Snapshot = /** @class */ (function () {
    function Snapshot(source) {
        this.state = 'getState' in source ? cloneState(source.getState()) : cloneState(source);
    }
    Snapshot.prototype.serialize = function () {
        return JSON.stringify({ state: this.state });
    };
    Snapshot.deserialize = function (serialized) {
        var parsed = JSON.parse(serialized);
        if (!parsed.state) {
            throw new Error('Invalid Plim snapshot: missing state.');
        }
        return new Snapshot(parsed.state);
    };
    return Snapshot;
}());
exports.Snapshot = Snapshot;
function createBlock(type, text, init) {
    var _a;
    if (text === void 0) { text = ''; }
    if (init === void 0) { init = {}; }
    return __assign(__assign(__assign({ id: (_a = init.id) !== null && _a !== void 0 ? _a : createId(), type: type, text: text }, (init.attrs ? { attrs: __assign({}, init.attrs) } : {})), (init.children ? { children: cloneBlocks(init.children) } : {})), (init.marks ? { marks: init.marks.map(function (mark) { return (__assign(__assign({}, mark), (mark.attrs ? { attrs: __assign({}, mark.attrs) } : {}))); }) } : {}));
}
function createContent(blocks, title) {
    if (blocks === void 0) { blocks = [createBlock('paragraph')]; }
    if (title === void 0) { title = 'Untitled'; }
    return { title: title, blocks: cloneBlocks(blocks) };
}
function cloneContent(content) {
    return { title: content.title, blocks: cloneBlocks(content.blocks) };
}
function cloneState(state) {
    return {
        content: cloneContent(state.content),
        selection: state.selection ? cloneSelection(state.selection) : null,
        readonly: state.readonly,
        version: state.version
    };
}
function cloneSelection(selection) {
    if (selection.kind === 'block') {
        return { kind: 'block', blockIds: __spreadArray([], selection.blockIds, true) };
    }
    return __assign({}, selection);
}
function evaluateTriggerRule(rule, state, trigger) {
    if (typeof rule === 'string') {
        return evaluateNamedRule(rule, state, trigger);
    }
    if (rule.kind === 'and') {
        return rule.rules.every(function (child) { return evaluateTriggerRule(child, state, trigger); });
    }
    if (rule.kind === 'or') {
        return rule.rules.some(function (child) { return evaluateTriggerRule(child, state, trigger); });
    }
    return !evaluateTriggerRule(rule.rule, state, trigger);
}
function triggerMatches(a, b) {
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === 'keyboard' && b.kind === 'keyboard') {
        return a.mode === b.mode && normalizeShortcut(a.value) === normalizeShortcut(b.value);
    }
    if (a.kind === 'clipboard' && b.kind === 'clipboard') {
        return a.action === b.action;
    }
    return false;
}
function operationApply(content, operations, selection) {
    var _a;
    var nextContent = cloneContent(content);
    var nextSelection = selection ? cloneSelection(selection) : null;
    var _loop_1 = function (operation) {
        if (operation.op === 'replaceContent') {
            nextContent = cloneContent(operation.content);
            return "continue";
        }
        if (operation.op === 'setSelection') {
            nextSelection = operation.selection ? cloneSelection(operation.selection) : null;
            return "continue";
        }
        if (operation.op === 'insertBlock') {
            var block = cloneBlock(operation.block);
            var at = operation.afterBlockId ? nextContent.blocks.findIndex(function (candidate) { return candidate.id === operation.afterBlockId; }) + 1 : nextContent.blocks.length;
            nextContent = __assign(__assign({}, nextContent), { blocks: __spreadArray(__spreadArray(__spreadArray([], nextContent.blocks.slice(0, Math.max(0, at)), true), [block], false), nextContent.blocks.slice(Math.max(0, at)), true) });
            return "continue";
        }
        if (operation.op === 'updateBlock') {
            nextContent = __assign(__assign({}, nextContent), { blocks: nextContent.blocks.map(function (block) {
                    return block.id === operation.blockId
                        ? __assign(__assign(__assign({}, block), operation.patch), { attrs: operation.patch.attrs ? __assign({}, operation.patch.attrs) : block.attrs, children: operation.patch.children ? cloneBlocks(operation.patch.children) : block.children, marks: operation.patch.marks ? operation.patch.marks.map(cloneMark) : block.marks }) : block;
                }) });
            return "continue";
        }
        if (operation.op === 'deleteBlock') {
            nextContent = __assign(__assign({}, nextContent), { blocks: nextContent.blocks.filter(function (block) { return block.id !== operation.blockId; }) });
            if ((nextSelection === null || nextSelection === void 0 ? void 0 : nextSelection.kind) !== 'block' && (nextSelection === null || nextSelection === void 0 ? void 0 : nextSelection.blockId) === operation.blockId) {
                nextSelection = null;
            }
            return "continue";
        }
        if (operation.op === 'toggleMark') {
            var blockId_1 = (_a = operation.range.blockId) !== null && _a !== void 0 ? _a : ((selection === null || selection === void 0 ? void 0 : selection.kind) !== 'block' ? selection === null || selection === void 0 ? void 0 : selection.blockId : undefined);
            if (!blockId_1) {
                return "continue";
            }
            nextContent = __assign(__assign({}, nextContent), { blocks: nextContent.blocks.map(function (block) {
                    var _a;
                    if (block.id !== blockId_1) {
                        return block;
                    }
                    var existing = (_a = block.marks) !== null && _a !== void 0 ? _a : [];
                    var matches = function (mark) {
                        return mark.mark === operation.mark && mark.from === operation.range.from && mark.to === operation.range.to;
                    };
                    var hasMark = existing.some(matches);
                    return __assign(__assign({}, block), { marks: hasMark
                            ? existing.filter(function (mark) { return !matches(mark); })
                            : __spreadArray(__spreadArray([], existing, true), [__assign({ mark: operation.mark, from: operation.range.from, to: operation.range.to }, (operation.attrs ? { attrs: operation.attrs } : {}))], false) });
                }) });
        }
    };
    for (var _i = 0, operations_1 = operations; _i < operations_1.length; _i++) {
        var operation = operations_1[_i];
        _loop_1(operation);
    }
    return { content: nextContent, selection: nextSelection };
}
function createId(prefix) {
    var _a, _b, _c;
    if (prefix === void 0) { prefix = 'plim'; }
    var random = (_c = (_b = (_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : Math.random().toString(36).slice(2);
    return "".concat(prefix, "-").concat(random);
}
function evaluateNamedRule(rule, state, trigger) {
    var _a, _b, _c;
    if (rule === 'selectionNotEmpty') {
        return Boolean(state.selection &&
            ((state.selection.kind === 'range' && state.selection.to > state.selection.from) ||
                (state.selection.kind === 'block' && state.selection.blockIds.length > 0)));
    }
    if (rule === 'blockSupportsDecoration') {
        return ((_a = state.selection) === null || _a === void 0 ? void 0 : _a.kind) !== 'block';
    }
    if (rule === 'startOfBlock') {
        return Boolean(((_b = state.selection) === null || _b === void 0 ? void 0 : _b.kind) !== 'block' && ((_c = state.selection) === null || _c === void 0 ? void 0 : _c.offset) === 0);
    }
    if (rule === 'precededByWhitespace') {
        if (!state.selection || state.selection.kind === 'block') {
            return false;
        }
        var block = state.content.blocks.find(function (candidate) { var _a; return candidate.id === ((_a = state.selection) === null || _a === void 0 ? void 0 : _a.blockId); });
        var offset = state.selection.kind === 'caret' ? state.selection.offset : state.selection.from;
        var previous = block === null || block === void 0 ? void 0 : block.text.at(offset - 1);
        return offset === 0 || previous === undefined || /\s/.test(previous) || ((trigger === null || trigger === void 0 ? void 0 : trigger.kind) === 'keyboard' && trigger.mode === 'character' && offset === (block === null || block === void 0 ? void 0 : block.text.length));
    }
    return false;
}
function cloneBlocks(blocks) {
    return blocks.map(cloneBlock);
}
function cloneBlock(block) {
    return __assign(__assign(__assign({ id: block.id, type: block.type, text: block.text }, (block.attrs ? { attrs: __assign({}, block.attrs) } : {})), (block.children ? { children: cloneBlocks(block.children) } : {})), (block.marks ? { marks: block.marks.map(cloneMark) } : {}));
}
function cloneMark(mark) {
    return __assign(__assign({}, mark), (mark.attrs ? { attrs: __assign({}, mark.attrs) } : {}));
}
function normalizeShortcut(value) {
    return value
        .split('+')
        .map(function (part) { return part.trim().toLowerCase(); })
        .sort()
        .join('+');
}
