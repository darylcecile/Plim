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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PlimAgnosticEditor_instances, _PlimAgnosticEditor_containerAdapter, _PlimAgnosticEditor_root, _PlimAgnosticEditor_state, _PlimAgnosticEditor_transactionListeners, _PlimAgnosticEditor_asyncListeners, _PlimAgnosticEditor_readyListeners, _PlimAgnosticEditor_isReady, _PlimAgnosticEditor_activeAbortController, _PlimAgnosticEditor_mount, _PlimAgnosticEditor_setState, _PlimAgnosticEditor_render, _PlimAgnosticEditor_renderBlock, _PlimAgnosticEditor_defaultBlockDOM, _PlimAgnosticEditor_actionIsAllowed, _PlimAgnosticEditor_matchesAnyCancellation, _PlimAgnosticEditor_createActionContext, _PlimAgnosticEditor_triggerAsyncEvent, _EditorTransactionBuilder_editor, _EditorTransactionBuilder_operations;
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachContainer = attachContainer;
exports.deriveEditor = deriveEditor;
var core_1 = require("@plim/core");
function attachContainer(getContainer) {
    return { getContainer: getContainer };
}
function deriveEditor(plim, options) {
    return new PlimAgnosticEditor(plim, options);
}
var PlimAgnosticEditor = /** @class */ (function () {
    function PlimAgnosticEditor(plim, options) {
        var _this = this;
        var _a, _b, _c;
        _PlimAgnosticEditor_instances.add(this);
        _PlimAgnosticEditor_containerAdapter.set(this, void 0);
        _PlimAgnosticEditor_root.set(this, null);
        _PlimAgnosticEditor_state.set(this, void 0);
        _PlimAgnosticEditor_transactionListeners.set(this, new Set());
        _PlimAgnosticEditor_asyncListeners.set(this, new Map());
        _PlimAgnosticEditor_readyListeners.set(this, new Set());
        _PlimAgnosticEditor_isReady.set(this, false);
        _PlimAgnosticEditor_activeAbortController.set(this, null);
        this.plim = plim;
        __classPrivateFieldSet(this, _PlimAgnosticEditor_containerAdapter, options.containerAdapter, "f");
        __classPrivateFieldSet(this, _PlimAgnosticEditor_state, {
            content: (0, core_1.cloneContent)((_a = options.initialContent) !== null && _a !== void 0 ? _a : (0, core_1.createContent)([(0, core_1.createBlock)('paragraph', '')], 'Untitled')),
            selection: null,
            readonly: (_b = options.readonly) !== null && _b !== void 0 ? _b : false,
            version: 0
        }, "f");
        this.plim.getHistory().attachRestore(function (state, transaction) {
            __classPrivateFieldGet(_this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_setState).call(_this, state, transaction);
        });
        __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_mount).call(this, (_c = options.autoFocus) !== null && _c !== void 0 ? _c : false);
    }
    Object.defineProperty(PlimAgnosticEditor.prototype, "isReady", {
        get: function () {
            return __classPrivateFieldGet(this, _PlimAgnosticEditor_isReady, "f");
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(PlimAgnosticEditor.prototype, "root", {
        get: function () {
            return __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f");
        },
        enumerable: false,
        configurable: true
    });
    PlimAgnosticEditor.prototype.getState = function () {
        return (0, core_1.cloneState)(__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f"));
    };
    PlimAgnosticEditor.prototype.onTransaction = function (listener) {
        var _this = this;
        __classPrivateFieldGet(this, _PlimAgnosticEditor_transactionListeners, "f").add(listener);
        return function () { return __classPrivateFieldGet(_this, _PlimAgnosticEditor_transactionListeners, "f").delete(listener); };
    };
    PlimAgnosticEditor.prototype.onAsyncEvent = function (name, listener) {
        var _this = this;
        var _a;
        var listeners = (_a = __classPrivateFieldGet(this, _PlimAgnosticEditor_asyncListeners, "f").get(name)) !== null && _a !== void 0 ? _a : new Set();
        listeners.add(listener);
        __classPrivateFieldGet(this, _PlimAgnosticEditor_asyncListeners, "f").set(name, listeners);
        return function () {
            listeners.delete(listener);
            if (listeners.size === 0) {
                __classPrivateFieldGet(_this, _PlimAgnosticEditor_asyncListeners, "f").delete(name);
            }
        };
    };
    PlimAgnosticEditor.prototype.whenReady = function (listener) {
        var _this = this;
        if (__classPrivateFieldGet(this, _PlimAgnosticEditor_isReady, "f")) {
            listener();
            return function () { return undefined; };
        }
        __classPrivateFieldGet(this, _PlimAgnosticEditor_readyListeners, "f").add(listener);
        return function () { return __classPrivateFieldGet(_this, _PlimAgnosticEditor_readyListeners, "f").delete(listener); };
    };
    PlimAgnosticEditor.prototype.dispatch = function (operations_1) {
        return __awaiter(this, arguments, void 0, function (operations, cause) {
            var before, applied, after, transaction, _i, _a, extension, _b, _c, listener;
            var _d;
            if (cause === void 0) { cause = { kind: 'api' }; }
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        if (__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").readonly) {
                            throw new Error('Cannot dispatch a transaction while the editor is read-only.');
                        }
                        before = (0, core_1.cloneState)(__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f"));
                        applied = (0, core_1.operationApply)(__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").content, operations, __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").selection);
                        after = {
                            content: applied.content,
                            selection: applied.selection,
                            readonly: __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").readonly,
                            version: __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").version + 1
                        };
                        transaction = {
                            id: (0, core_1.createId)('transaction'),
                            timestamp: Date.now(),
                            operations: operations,
                            before: before,
                            after: (0, core_1.cloneState)(after),
                            cause: cause
                        };
                        __classPrivateFieldSet(this, _PlimAgnosticEditor_state, after, "f");
                        __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_render).call(this);
                        this.plim._recordTransaction(transaction);
                        _i = 0, _a = this.plim.getExtensions(this);
                        _e.label = 1;
                    case 1:
                        if (!(_i < _a.length)) return [3 /*break*/, 4];
                        extension = _a[_i];
                        return [4 /*yield*/, ((_d = extension.onTransaction) === null || _d === void 0 ? void 0 : _d.call(extension, transaction, { plim: this.plim }))];
                    case 2:
                        _e.sent();
                        _e.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4:
                        for (_b = 0, _c = __classPrivateFieldGet(this, _PlimAgnosticEditor_transactionListeners, "f"); _b < _c.length; _b++) {
                            listener = _c[_b];
                            listener(transaction);
                        }
                        return [2 /*return*/, transaction];
                }
            });
        });
    };
    PlimAgnosticEditor.prototype.dispatchTrigger = function (trigger) {
        return __awaiter(this, void 0, void 0, function () {
            var actions, results, _i, actions_1, action, abortController, ctx, _a, _b;
            var _this = this;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (__classPrivateFieldGet(this, _PlimAgnosticEditor_activeAbortController, "f") && __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_matchesAnyCancellation).call(this, trigger)) {
                            __classPrivateFieldGet(this, _PlimAgnosticEditor_activeAbortController, "f").abort();
                            __classPrivateFieldSet(this, _PlimAgnosticEditor_activeAbortController, null, "f");
                            return [2 /*return*/, []];
                        }
                        actions = this.plim
                            .getRegisteredActions(this)
                            .filter(function (action) { return action.trigger && normalizeTriggers(action.trigger).some(function (candidate) { return (0, core_1.triggerMatches)(candidate, trigger); }); })
                            .filter(function (action) { return __classPrivateFieldGet(_this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_actionIsAllowed).call(_this, action, trigger); });
                        results = [];
                        _i = 0, actions_1 = actions;
                        _c.label = 1;
                    case 1:
                        if (!(_i < actions_1.length)) return [3 /*break*/, 6];
                        action = actions_1[_i];
                        abortController = new AbortController();
                        __classPrivateFieldSet(this, _PlimAgnosticEditor_activeAbortController, abortController, "f");
                        ctx = __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_createActionContext).call(this, abortController);
                        _c.label = 2;
                    case 2:
                        _c.trys.push([2, , 4, 5]);
                        _b = (_a = results).push;
                        return [4 /*yield*/, action.perform(this.getState(), ctx)];
                    case 3:
                        _b.apply(_a, [_c.sent()]);
                        return [3 /*break*/, 5];
                    case 4:
                        if (__classPrivateFieldGet(this, _PlimAgnosticEditor_activeAbortController, "f") === abortController) {
                            __classPrivateFieldSet(this, _PlimAgnosticEditor_activeAbortController, null, "f");
                        }
                        return [7 /*endfinally*/];
                    case 5:
                        _i++;
                        return [3 /*break*/, 1];
                    case 6: return [2 /*return*/, results];
                }
            });
        });
    };
    PlimAgnosticEditor.prototype.restoreSnapshot = function (snapshot) {
        var before = (0, core_1.cloneState)(__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f"));
        var after = (0, core_1.cloneState)(snapshot.state);
        var transaction = {
            id: (0, core_1.createId)('snapshot'),
            timestamp: Date.now(),
            operations: [{ op: 'replaceContent', content: after.content }, { op: 'setSelection', selection: after.selection }],
            before: before,
            after: after,
            cause: { kind: 'api' }
        };
        __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_setState).call(this, after, transaction);
    };
    PlimAgnosticEditor.prototype.destroy = function () {
        var _a;
        (_a = __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f")) === null || _a === void 0 ? void 0 : _a.replaceChildren();
        __classPrivateFieldGet(this, _PlimAgnosticEditor_transactionListeners, "f").clear();
        __classPrivateFieldGet(this, _PlimAgnosticEditor_asyncListeners, "f").clear();
        __classPrivateFieldGet(this, _PlimAgnosticEditor_readyListeners, "f").clear();
        __classPrivateFieldSet(this, _PlimAgnosticEditor_isReady, false, "f");
    };
    return PlimAgnosticEditor;
}());
_PlimAgnosticEditor_containerAdapter = new WeakMap(), _PlimAgnosticEditor_root = new WeakMap(), _PlimAgnosticEditor_state = new WeakMap(), _PlimAgnosticEditor_transactionListeners = new WeakMap(), _PlimAgnosticEditor_asyncListeners = new WeakMap(), _PlimAgnosticEditor_readyListeners = new WeakMap(), _PlimAgnosticEditor_isReady = new WeakMap(), _PlimAgnosticEditor_activeAbortController = new WeakMap(), _PlimAgnosticEditor_instances = new WeakSet(), _PlimAgnosticEditor_mount = function _PlimAgnosticEditor_mount(autoFocus) {
    var container = __classPrivateFieldGet(this, _PlimAgnosticEditor_containerAdapter, "f").getContainer();
    if (!container) {
        throw new Error('Plim editor container could not be found.');
    }
    __classPrivateFieldSet(this, _PlimAgnosticEditor_root, container, "f");
    this.plim.getRegisteredBlocks(this);
    this.plim.getRegisteredMarks(this);
    this.plim.getRegisteredActions(this);
    __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f").classList.add('plim-editor-root');
    __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_render).call(this);
    __classPrivateFieldSet(this, _PlimAgnosticEditor_isReady, true, "f");
    for (var _i = 0, _a = __classPrivateFieldGet(this, _PlimAgnosticEditor_readyListeners, "f"); _i < _a.length; _i++) {
        var listener = _a[_i];
        listener();
    }
    __classPrivateFieldGet(this, _PlimAgnosticEditor_readyListeners, "f").clear();
    if (autoFocus) {
        var firstBlock = __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f").querySelector('[data-plim-block-content="true"]');
        firstBlock === null || firstBlock === void 0 ? void 0 : firstBlock.focus();
    }
}, _PlimAgnosticEditor_setState = function _PlimAgnosticEditor_setState(state, transaction) {
    __classPrivateFieldSet(this, _PlimAgnosticEditor_state, (0, core_1.cloneState)(state), "f");
    __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_render).call(this);
    for (var _i = 0, _a = __classPrivateFieldGet(this, _PlimAgnosticEditor_transactionListeners, "f"); _i < _a.length; _i++) {
        var listener = _a[_i];
        listener(transaction);
    }
}, _PlimAgnosticEditor_render = function _PlimAgnosticEditor_render() {
    var _this = this;
    if (!__classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f")) {
        return;
    }
    var blocks = new Map(this.plim.getRegisteredBlocks(this).map(function (block) { return [block.name, block]; }));
    __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f").dataset.plimTheme = typeof this.plim.theme === 'string' ? this.plim.theme : this.plim.theme.name;
    __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f").replaceChildren();
    var shell = document.createElement('article');
    shell.className = 'plim-editor';
    var title = document.createElement('h1');
    title.className = 'plim-title';
    title.contentEditable = String(!__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").readonly);
    title.dataset.plimTitle = 'true';
    title.textContent = __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").content.title;
    title.setAttribute('aria-label', 'Page title');
    title.addEventListener('input', function () {
        var _a;
        if (__classPrivateFieldGet(_this, _PlimAgnosticEditor_state, "f").readonly) {
            return;
        }
        var content = (0, core_1.cloneContent)(__classPrivateFieldGet(_this, _PlimAgnosticEditor_state, "f").content);
        content.title = (_a = title.textContent) !== null && _a !== void 0 ? _a : '';
        void _this.dispatch([{ op: 'replaceContent', content: content }], { kind: 'text-input', text: content.title });
    });
    shell.append(title);
    var blockList = document.createElement('div');
    blockList.className = 'plim-block-list';
    for (var _i = 0, _a = __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").content.blocks; _i < _a.length; _i++) {
        var block = _a[_i];
        blockList.append(__classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_renderBlock).call(this, block, blocks.get(block.type)));
    }
    shell.append(blockList);
    __classPrivateFieldGet(this, _PlimAgnosticEditor_root, "f").append(shell);
}, _PlimAgnosticEditor_renderBlock = function _PlimAgnosticEditor_renderBlock(block, definition) {
    var _this = this;
    var _a, _b, _c, _d;
    var row = document.createElement('section');
    row.className = 'plim-block';
    row.dataset.blockId = block.id;
    row.dataset.blockType = block.type;
    var controls = document.createElement('div');
    controls.className = 'plim-block-controls';
    var addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'plim-block-add';
    addButton.textContent = '+';
    addButton.setAttribute('aria-label', 'Add block');
    addButton.addEventListener('click', function () {
        var newBlock = (0, core_1.createBlock)('paragraph', '');
        void _this.dispatch([{ op: 'insertBlock', block: newBlock, afterBlockId: block.id }], { kind: 'command', commandId: 'insert-paragraph' });
    });
    var handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'plim-block-handle';
    handle.textContent = '⋮⋮';
    handle.setAttribute('aria-label', 'Block handle');
    controls.append(addButton, handle);
    row.append(controls);
    var payload = {
        block: block,
        content: block.text,
        attributes: {
            'data-plim-block-content': 'true'
        },
        readonly: __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").readonly,
        selected: ((_a = __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").selection) === null || _a === void 0 ? void 0 : _a.kind) === 'block' && __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").selection.blockIds.includes(block.id)
    };
    var content = (_c = (_b = definition === null || definition === void 0 ? void 0 : definition.toDOM) === null || _b === void 0 ? void 0 : _b.call(definition, payload)) !== null && _c !== void 0 ? _c : __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_defaultBlockDOM).call(this, block);
    content.classList.add('plim-block-content');
    content.dataset.plimBlockContent = 'true';
    content.contentEditable = String(!__classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f").readonly && !((_d = definition === null || definition === void 0 ? void 0 : definition.atom) !== null && _d !== void 0 ? _d : false));
    content.setAttribute('role', 'textbox');
    content.setAttribute('aria-label', "".concat(block.type, " block"));
    content.addEventListener('focus', function () {
        __classPrivateFieldGet(_this, _PlimAgnosticEditor_state, "f").selection = { kind: 'caret', blockId: block.id, offset: block.text.length };
    });
    content.addEventListener('input', function () {
        var _a;
        if (__classPrivateFieldGet(_this, _PlimAgnosticEditor_state, "f").readonly) {
            return;
        }
        var text = (_a = content.textContent) !== null && _a !== void 0 ? _a : '';
        void _this.dispatch([
            {
                op: 'updateBlock',
                blockId: block.id,
                patch: { text: text }
            },
            {
                op: 'setSelection',
                selection: { kind: 'caret', blockId: block.id, offset: text.length }
            }
        ], { kind: 'text-input', text: text });
    });
    content.addEventListener('keydown', function (event) {
        var trigger = keyboardEventToTrigger(event);
        if (trigger) {
            void _this.dispatchTrigger(trigger);
        }
        if (event.key === 'Enter' && !event.shiftKey && !__classPrivateFieldGet(_this, _PlimAgnosticEditor_state, "f").readonly) {
            event.preventDefault();
            var newBlock = (0, core_1.createBlock)('paragraph', '');
            void _this.dispatch([{ op: 'insertBlock', block: newBlock, afterBlockId: block.id }], { kind: 'keyboard', key: 'Enter' });
        }
    });
    row.append(content);
    return row;
}, _PlimAgnosticEditor_defaultBlockDOM = function _PlimAgnosticEditor_defaultBlockDOM(block) {
    if (block.type === 'heading1') {
        var heading = document.createElement('h2');
        heading.textContent = block.text;
        return heading;
    }
    if (block.type === 'heading2') {
        var heading = document.createElement('h3');
        heading.textContent = block.text;
        return heading;
    }
    if (block.type === 'heading3') {
        var heading = document.createElement('h4');
        heading.textContent = block.text;
        return heading;
    }
    if (block.type === 'quote') {
        var quote = document.createElement('blockquote');
        quote.textContent = block.text;
        return quote;
    }
    if (block.type === 'divider') {
        var divider = document.createElement('hr');
        divider.contentEditable = 'false';
        return divider;
    }
    if (block.type === 'bulletedList' || block.type === 'numberedList') {
        var item = document.createElement('li');
        item.textContent = block.text;
        return item;
    }
    var paragraph = document.createElement('p');
    paragraph.textContent = block.text;
    return paragraph;
}, _PlimAgnosticEditor_actionIsAllowed = function _PlimAgnosticEditor_actionIsAllowed(action, trigger) {
    if (!action.triggerValidationRules) {
        return true;
    }
    return (0, core_1.evaluateTriggerRule)(action.triggerValidationRules(core_1.triggerRuleBuilders), __classPrivateFieldGet(this, _PlimAgnosticEditor_state, "f"), trigger);
}, _PlimAgnosticEditor_matchesAnyCancellation = function _PlimAgnosticEditor_matchesAnyCancellation(trigger) {
    var actions = this.plim.getRegisteredActions(this);
    return actions.some(function (action) { var _a; return (_a = action.cancellationTriggers) === null || _a === void 0 ? void 0 : _a.some(function (candidate) { return (0, core_1.triggerMatches)(candidate, trigger); }); });
}, _PlimAgnosticEditor_createActionContext = function _PlimAgnosticEditor_createActionContext(abortController) {
    var _this = this;
    return {
        createTransaction: function () { return new EditorTransactionBuilder(_this); },
        triggerAsyncEvent: function (name, detail) { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
            return [2 /*return*/, __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_triggerAsyncEvent).call(this, name, detail, abortController)];
        }); }); },
        signal: abortController.signal,
        isCancelled: function () { return abortController.signal.aborted; }
    };
}, _PlimAgnosticEditor_triggerAsyncEvent = function _PlimAgnosticEditor_triggerAsyncEvent(name, detail, abortController) {
    return __awaiter(this, void 0, void 0, function () {
        var event, ctx, results, _i, _a, extension, _b, _c, _d, _e, listener, _f, _g;
        var _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    event = __assign(__assign({ name: name }, (detail === undefined ? {} : { detail: detail })), { signal: abortController.signal });
                    ctx = __classPrivateFieldGet(this, _PlimAgnosticEditor_instances, "m", _PlimAgnosticEditor_createActionContext).call(this, abortController);
                    results = [];
                    _i = 0, _a = this.plim.getExtensions(this);
                    _k.label = 1;
                case 1:
                    if (!(_i < _a.length)) return [3 /*break*/, 4];
                    extension = _a[_i];
                    _c = (_b = results).push;
                    return [4 /*yield*/, ((_h = extension.onAsyncEvent) === null || _h === void 0 ? void 0 : _h.call(extension, event, this.getState(), ctx))];
                case 2:
                    _c.apply(_b, [_k.sent()]);
                    _k.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4:
                    _d = 0, _e = (_j = __classPrivateFieldGet(this, _PlimAgnosticEditor_asyncListeners, "f").get(name)) !== null && _j !== void 0 ? _j : [];
                    _k.label = 5;
                case 5:
                    if (!(_d < _e.length)) return [3 /*break*/, 8];
                    listener = _e[_d];
                    _g = (_f = results).push;
                    return [4 /*yield*/, listener(event, this.getState(), ctx)];
                case 6:
                    _g.apply(_f, [_k.sent()]);
                    _k.label = 7;
                case 7:
                    _d++;
                    return [3 /*break*/, 5];
                case 8: return [2 /*return*/, results];
            }
        });
    });
};
var EditorTransactionBuilder = /** @class */ (function () {
    function EditorTransactionBuilder(editor) {
        _EditorTransactionBuilder_editor.set(this, void 0);
        _EditorTransactionBuilder_operations.set(this, []);
        __classPrivateFieldSet(this, _EditorTransactionBuilder_editor, editor, "f");
    }
    EditorTransactionBuilder.prototype.insertBlock = function (block, afterBlockId) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push(__assign({ op: 'insertBlock', block: block }, (afterBlockId ? { afterBlockId: afterBlockId } : {})));
        return this;
    };
    EditorTransactionBuilder.prototype.updateBlock = function (blockId, patch) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push({ op: 'updateBlock', blockId: blockId, patch: patch });
        return this;
    };
    EditorTransactionBuilder.prototype.deleteBlock = function (blockId) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push({ op: 'deleteBlock', blockId: blockId });
        return this;
    };
    EditorTransactionBuilder.prototype.toggleMark = function (mark, range, attrs) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push(__assign({ op: 'toggleMark', mark: mark, range: range }, (attrs ? { attrs: attrs } : {})));
        return this;
    };
    EditorTransactionBuilder.prototype.replaceContent = function (content) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push({ op: 'replaceContent', content: content });
        return this;
    };
    EditorTransactionBuilder.prototype.setSelection = function (selection) {
        __classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f").push({ op: 'setSelection', selection: selection });
        return this;
    };
    EditorTransactionBuilder.prototype.commit = function (cause) {
        if (cause === void 0) { cause = { kind: 'api' }; }
        return __classPrivateFieldGet(this, _EditorTransactionBuilder_editor, "f").dispatch(__classPrivateFieldGet(this, _EditorTransactionBuilder_operations, "f"), cause);
    };
    return EditorTransactionBuilder;
}());
_EditorTransactionBuilder_editor = new WeakMap(), _EditorTransactionBuilder_operations = new WeakMap();
function normalizeTriggers(trigger) {
    return Array.isArray(trigger) ? trigger : [trigger];
}
function keyboardEventToTrigger(event) {
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        return { kind: 'keyboard', mode: 'character', value: event.key };
    }
    var modifiers = [
        event.metaKey || event.ctrlKey ? 'Mod' : '',
        event.shiftKey ? 'Shift' : '',
        event.altKey ? 'Alt' : '',
        event.key.length > 1 ? event.key : event.key.toLowerCase()
    ].filter(Boolean);
    if (modifiers.length > 1) {
        return { kind: 'keyboard', mode: 'shortcut', value: modifiers.join('+') };
    }
    return { kind: 'keyboard', mode: 'key', value: event.key };
}
