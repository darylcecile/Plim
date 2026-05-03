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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAsyncEventListener = useAsyncEventListener;
exports.useEditorHandle = useEditorHandle;
exports.PlimEditor = PlimEditor;
var react_1 = require("react");
var editor_1 = require("@plim/editor");
function useAsyncEventListener(eventName, listener) {
    var latest = (0, react_1.useRef)(listener);
    latest.current = listener;
    return (0, react_1.useMemo)(function () { return ({
        eventName: eventName,
        listener: (function (event, state, ctx) { return latest.current(event, state, ctx); })
    }); }, [eventName]);
}
function useEditorHandle() {
    return (0, react_1.useRef)(null);
}
function PlimEditor(_a) {
    var plim = _a.plim, handle = _a.handle, initialContent = _a.initialContent, _b = _a.readonly, readonly = _b === void 0 ? false : _b, _c = _a.autoFocus, autoFocus = _c === void 0 ? false : _c, onTransaction = _a.onTransaction, whenReady = _a.whenReady, _d = _a.asyncEventListeners, asyncEventListeners = _d === void 0 ? [] : _d, className = _a.className;
    var rootRef = (0, react_1.useRef)(null);
    var editorRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(function () {
        if (!rootRef.current) {
            return undefined;
        }
        var editor = (0, editor_1.deriveEditor)(plim, __assign(__assign({ containerAdapter: (0, editor_1.attachContainer)(function () { return rootRef.current; }) }, (initialContent ? { initialContent: initialContent } : {})), { readonly: readonly, autoFocus: autoFocus }));
        editorRef.current = editor;
        if (handle) {
            handle.current = editor;
        }
        var cleanup = [];
        if (onTransaction) {
            cleanup.push(editor.onTransaction(onTransaction));
        }
        if (whenReady) {
            cleanup.push(editor.whenReady(whenReady));
        }
        for (var _i = 0, asyncEventListeners_1 = asyncEventListeners; _i < asyncEventListeners_1.length; _i++) {
            var registration = asyncEventListeners_1[_i];
            cleanup.push(editor.onAsyncEvent(registration.eventName, registration.listener));
        }
        return function () {
            for (var _i = 0, cleanup_1 = cleanup; _i < cleanup_1.length; _i++) {
                var dispose = cleanup_1[_i];
                dispose();
            }
            editor.destroy();
            editorRef.current = null;
            if (handle) {
                handle.current = null;
            }
        };
    }, [plim, initialContent, readonly, autoFocus, onTransaction, whenReady, asyncEventListeners, handle]);
    return <div ref={rootRef} className={className} data-plim-react-editor="true"/>;
}
