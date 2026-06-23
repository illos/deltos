import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { history, undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import type { BlockBody } from '@deltos/shared';
import { deltoSchema } from './schema.js';
import { uniqueBlockIdPlugin } from './plugins/blockId.js';
import { buildKeymapPlugin } from './keymap.js';
import { buildInputRulesPlugin } from './inputRules.js';
import { buildAutolinkKeymap } from './autolink.js';
import { spineToPmDoc, pmDocToSpine, extractTitleFromDoc } from './serializer.js';
import { buildPluginIslandNodeViews } from './nodeviews/PluginIsland.js';
// Importing the embeds plugin registers the link_card NodeView (side-effect) + provides the paste-to-card
// handler (#69 E2b). Editor core never imports plugins; this host wiring is the single allowed touch-point.
import { linkCardPastePlugin } from '../plugins/embeds/index.js';
// Inline-formula framework (docs/specs/inline-formulas.md) — self-contained: the registry (math is the
// Phase-1 type), the '=' auto + '[...]' bracket input rules, the backspace-unwrap keymap, and the
// type-dispatched NodeView. Editor core never imports plugins; this is the single host wiring touch-point.
import { createDefaultFormulaRegistry, buildFormulaPlugins, buildFormulaNodeView } from '../plugins/formula/index.js';
import { TodoItemView } from './nodeviews/TodoItem.js';
import { sliceToPlainText } from './clipboard.js';
import { EditorControlStrip } from './EditorControlStrip.js';
import { DesktopContextSlot } from './DesktopContextSlot.js';
import { MobileEditorBar } from './MobileEditorBar.js';
import { KeypadLoadout } from '../deck/index.js';
import type { DeckContext, DeckLoadoutRegistry, KeyActions } from '../deck/index.js';
import { deriveDeckContext, buildPmKeyActions } from './deckAdapter.js';
import { useDeckHost } from '../components/DeckHost.js';
import { useEditorLoadoutTools, EditorGroupSelector, EditorGroupSubmenu } from './editorLoadoutTools.js';
import { createSpellcheckPlugin, applySpellCorrection } from './spellcheckPlugin.js';
import type { SpellTap } from './spellcheckPlugin.js';
import { SpellSuggestionPopover } from './SpellSuggestionPopover.js';
import { SpellSuggestionBar } from './SpellSuggestionBar.js';
import { openLinkInNewTab, normalizeLinkInput } from './openLink.js';
import { LinkEntryBar } from './LinkEntryBar.js';
import type { LinkField } from './LinkEntryBar.js';
import { useSpellcheckStore } from '../lib/useSpellcheck.js';
import { observeWords, addWord } from '../lib/dictionaryStore.js';
import { useVoiceMode, VoiceLoadout, isAudioCaptureSupported } from '../deck/index.js';
import { createDeltosTranscriber } from './voiceTranscriber.js';
import type { SpellEngine } from '../deck/index.js';
import { deriveActiveState, EMPTY_ACTIVE_STATE } from './editorState.js';
import type { EditorActiveState } from './editorState.js';
import type { ToolDescriptor } from './editorTools.js';
import { useIsDesktop } from '../lib/useIsDesktop.js';
import { useCustomKeyboard } from '../lib/useCustomKeyboard.js';
import { useKeypadSwipe } from '../lib/useKeypadSwipe.js';

interface ProseMirrorEditorProps {
  noteId: string;
  initialTitle: string;
  initialBody: BlockBody;
  onChange: (title: string, body: BlockBody) => void;
  autoFocus?: boolean;
  /** Called in effect cleanup after the final onChange flush — signals "left the note". */
  onLeave?: () => void;
  /** Test seam: called with the EditorView on creation and null on destruction. */
  onViewInit?: (view: EditorView | null) => void;
}

const SAVE_DEBOUNCE_MS = 400;
/** PM history group delay: continuous typing within this window collapses to one undo step. */
export const HISTORY_GROUP_DELAY_MS = 500;

/**
 * Decoration plugin: adds `data-empty` on the title node when it has no text content,
 * so CSS can show the 'Title' placeholder via ::before without touching PM's DOM.
 */
const titlePlaceholderPlugin = new Plugin({
  props: {
    decorations(state) {
      const first = state.doc.firstChild;
      if (!first || first.type.name !== 'title' || first.textContent !== '') return null;
      return DecorationSet.create(state.doc, [
        Decoration.node(0, first.nodeSize, { 'data-empty': '' }),
      ]);
    },
  },
});

/**
 * ProseMirror editor component. Manages the EditorView lifecycle imperatively;
 * React owns the mount/unmount, PM owns the document.
 *
 * The document structure is `title block*`: the first node is always the note title
 * (an h1 within the single contenteditable), and body blocks follow. This makes Enter
 * from title → body work natively, and drag-selection spans title + body in one gesture.
 *
 * When noteId changes (navigating to a different note), the view is destroyed and re-created
 * with the new document. Within a single note, all mutations go through PM transactions.
 *
 * Mobile IME note (iOS): ProseMirror handles composition events natively. The editor div
 * must NOT have `suppressContentEditableWarning` or other React-managed contenteditable
 * attributes — React's synthetic event system and ProseMirror's conflict on the same DOM node.
 * The ref div is passed to PM's constructor and React does not touch it thereafter.
 */
export function ProseMirrorEditor({
  noteId,
  initialTitle,
  initialBody,
  onChange,
  autoFocus = false,
  onLeave,
  onViewInit,
}: ProseMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // #69 §5 spellcheck: the base plugin list (so the spellcheck plugin can be added/removed by reconfigure
  // when the toggle flips) + the lazily-created off-thread engine.
  const basePluginsRef = useRef<Plugin[]>([]);
  const spellEngineRef = useRef<SpellEngine | null>(null);
  // §5.2 custom dictionary: the live allow-list (account-synced) fed to the engine; recheckSpellRef lets
  // an allow-list change force a re-check (no doc edit). dictWordsRef mirrors the state for engine-create.
  const recheckSpellRef = useRef<(() => void) | null>(null);
  const dictWordsRef = useRef<string[]>([]);
  const isDesktop = useIsDesktop();
  // #69: the custom keyboard is opt-in (Settings, default OFF) + mobile-only. When ON the editor
  // suppresses the native keyboard (inputmode=none) and shows our context-driven Deck.
  const [customKbEnabled] = useCustomKeyboard();
  const customKb = customKbEnabled && !isDesktop;
  // One selection-driven snapshot drives every toolbar button + undo/redo availability.
  const [active, setActive] = useState<EditorActiveState>(EMPTY_ACTIVE_STATE);
  // #69 §5 spellcheck: on only when the toggle is enabled AND its deviceState read has resolved (so a
  // user who disabled it never spins up the worker during the brief IDB read). The popover anchors a
  // tapped misspelling's suggestions.
  const spellOn = useSpellcheckStore((s) => s.enabled && s._loaded);
  // The active spell suggestion (one state, two presentations): the Deck TOP-SLOT bar in custom-keyboard
  // mode (§5.1), else the anchored popover (non-Deck fallback). x/y are only used by the popover.
  const [spellSuggest, setSpellSuggest] = useState<
    { x: number; y: number; from: number; to: number; word: string; suggestions: string[] } | null
  >(null);
  // A squiggle was tapped → look up suggestions (off-thread) + surface them (top-slot bar in custom mode,
  // popover otherwise — the render branches on customKb). Declared before deckLoadouts (which renders the bar).
  const handleSpellTap = useCallback((t: SpellTap) => {
    const engine = spellEngineRef.current;
    if (!engine) return;
    void engine.lookup(t.word, 6).then((sugs) => {
      if (t.view.isDestroyed) return;
      const coords = t.view.coordsAtPos(t.from);
      setSpellSuggest({ x: coords.left, y: coords.bottom + 4, from: t.from, to: t.to, word: t.word, suggestions: sugs.map((s) => s.word) });
    });
  }, []);
  // Tap-elsewhere (non-squiggle) → dismiss the suggestion bar/popover.
  const handleSpellDismiss = useCallback(() => setSpellSuggest(null), []);
  // Pick a suggestion → replace the word in one txn (slice-3 seam), then clear.
  const handleSpellPick = useCallback((from: number, to: number, replacement: string) => {
    const v = viewRef.current;
    if (v) applySpellCorrection(v, from, to, replacement);
    setSpellSuggest(null);
  }, []);
  // [+ Add to dictionary] → add the flagged word (optimistic+synced); the observeWords subscription below
  // pushes the new allow-list to the engine + re-checks, so the squiggle clears. Dismiss the bar.
  const handleAddToDictionary = useCallback((word: string) => {
    void addWord(word);
    setSpellSuggest(null);
  }, []);
  // §5.2: the account-synced custom dictionary (allow-list). Subscribe once; feed every change to the
  // engine + force a re-check (no doc edit) so newly-added/removed words (re)flag immediately.
  const [dictWords, setDictWords] = useState<string[]>([]);
  useEffect(() => observeWords((words) => { dictWordsRef.current = words; setDictWords(words); }), []);
  useEffect(() => {
    spellEngineRef.current?.setAllowList(dictWords);
    recheckSpellRef.current?.();
  }, [dictWords]);
  // Reactive view + selection context for the Deck. The keyboard's visibility is driven by
  // customKb (editor mounted = a note open + the toggle on), NOT by editor focus — a focus-gated
  // keyboard was being torn down by incidental tap-blurs (#69 single-tap) and by sync-driven re-renders
  // that drop focus (#328 irregular hide). Owning the bottom slot whenever a note is open is robust to
  // both and matches the north-star (the footprint is always the surface while editing).
  const [deckContext, setDeckContext] = useState<DeckContext>('text');
  // Inline-formula registry (docs/specs/inline-formulas.md) — Phase-1 holds math; injected into the plugins,
  // the NodeView, AND the deckAdapter (so the '=' / '[...]' triggers fire on the custom keypad too). Stable
  // per editor instance (loadout-aware: a future loadout could build its own).
  const formulaRegistry = useRef(createDefaultFormulaRegistry()).current;
  // The keypad's abstract KeyActions, wired to PM via the adapter (closes over viewRef → stable across
  // view re-creation). The Deck loadout registry for this host: the 'text' context → the keypad.
  const deckActions = useRef(buildPmKeyActions(() => viewRef.current, formulaRegistry)).current;
  // #69 Deck link fix: inline URL+TITLE entry typed ON THE KEYPAD (window.prompt is unreliable in an
  // installed PWA / inputmode=none). A clean two-field form (Title = the visible clickable text, URL = the
  // href) — drops the old select-text model. While open, the keypad routes into whichever field is active
  // (see deckActionsForKeypad); apply inserts the linked title text at the caret. The url+title GUI is the
  // forward-compatible seed of the #62 params form (rep migrates mark → [url:title=…] node, form stays).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [activeLinkField, setActiveLinkField] = useState<LinkField>('title');
  const linkOpenRef = useRef(linkOpen);
  const linkTitleRef = useRef(linkTitle);
  const linkUrlRef = useRef(linkUrl);
  const activeLinkFieldRef = useRef(activeLinkField);
  useLayoutEffect(() => {
    linkOpenRef.current = linkOpen;
    linkTitleRef.current = linkTitle;
    linkUrlRef.current = linkUrl;
    activeLinkFieldRef.current = activeLinkField;
  });
  const closeLink = useCallback(() => {
    setLinkOpen(false); setLinkTitle(''); setLinkUrl(''); setActiveLinkField('title');
  }, []);
  const cancelLink = useCallback(() => { closeLink(); viewRef.current?.focus(); }, [closeLink]);
  const submitLink = useCallback(() => {
    const view = viewRef.current;
    const wasOpen = linkOpenRef.current;
    const href = normalizeLinkInput(linkUrlRef.current); // null = empty / unsafe scheme → drop
    const text = (linkTitleRef.current.trim() || linkUrlRef.current.trim());
    closeLink();
    if (!wasOpen || !view) return;
    const linkType = deltoSchema.marks['link'];
    if (href && text && linkType) {
      // Insert the title as linked text at the caret (replacing any selection).
      const { from, to } = view.state.selection;
      const tr = view.state.tr.insertText(text, from, to);
      tr.addMark(from, from + text.length, linkType.create({ href, title: null }));
      view.dispatch(tr);
    }
    view.focus();
  }, [closeLink]);
  const submitLinkRef = useRef(submitLink);
  useLayoutEffect(() => { submitLinkRef.current = submitLink; });
  // Wrap the keypad actions so that WHILE link entry is open, keys route into the ACTIVE field's buffer (no
  // native keyboard) instead of the document; Enter advances Title→URL, then applies. Built once; preserves
  // which OPTIONAL capabilities the base actions expose (so trackpad / auto-cap / double-space aren't
  // spuriously enabled by the wrapper).
  const deckActionsForKeypad = useRef<KeyActions>((() => {
    const editActive = (fn: (s: string) => string) => {
      if (activeLinkFieldRef.current === 'url') setLinkUrl(fn); else setLinkTitle(fn);
    };
    const wrapped: KeyActions = {
      insert: (t) => { if (linkOpenRef.current) editActive((s) => s + t); else deckActions.insert(t); },
      backspace: () => { if (linkOpenRef.current) editActive((s) => s.slice(0, -1)); else deckActions.backspace(); },
      enter: () => {
        if (!linkOpenRef.current) { deckActions.enter(); return; }
        if (activeLinkFieldRef.current === 'title') setActiveLinkField('url'); // advance Title → URL
        else submitLinkRef.current();                                          // URL → apply
      },
    };
    if (deckActions.sentenceSpace) {
      wrapped.sentenceSpace = () => { if (linkOpenRef.current) editActive((s) => `${s} `); else deckActions.sentenceSpace!(); };
    }
    if (deckActions.shouldAutoCapitalize) {
      // Don't auto-capitalize the URL; the Title may capitalize normally.
      wrapped.shouldAutoCapitalize = () => {
        if (!linkOpenRef.current) return deckActions.shouldAutoCapitalize!();
        return activeLinkFieldRef.current === 'title';
      };
    }
    if (deckActions.moveCaret) {
      wrapped.moveCaret = (dx, dy) => { if (!linkOpenRef.current) deckActions.moveCaret!(dx, dy); };
    }
    return wrapped;
  })()).current;
  // #69 C-manual: keypad show/hide. The keypad LAYER collapses (the note reclaims its height); a persistent
  // base region keeps the show/hide toggle. State lives HERE (not in the Deck) because auto-show keys off PM
  // focus and the caret clearance depends on it. Default shown (entering a note shows the keypad, as before).
  const [keypadShown, setKeypadShown] = useState(true);
  // locked = auto-show/hide suspended (long-press the toggle). "tap drives; long-press decides if the
  // keyboard may drive itself." Read inside the PM focus handler (created once at view-creation) → ref.
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(locked);
  useLayoutEffect(() => { lockedRef.current = locked; });
  const toggleKeypad = useCallback(() => setKeypadShown((s) => !s), []);
  const toggleLock = useCallback(() => setLocked((l) => !l), []);
  // #69 §7 keypad show/hide gestures on the note body (custom-keyboard only). A caret-placing TAP re-shows
  // the keypad (the PM focus event only fires on focus-IN, so a tap within an already-focused editor — after
  // a manual or swipe hide — wouldn't otherwise re-show it); a fast+large upward FLICK hides it. PASSIVE
  // (never captures/preventDefaults) so note scrolling is untouched. Both respect the manual lock (frozen).
  const keypadSwipe = useKeypadSwipe({
    enabled: customKb,
    onTap: () => { if (!lockedRef.current) setKeypadShown(true); },
    onSwipeUp: () => { if (!lockedRef.current) setKeypadShown(false); },
  });
  // #69 editor-loadout v1: the group selector (below keys) + per-group submenu (above keys) share one
  // open-group state. They're host-injected into the generic KeypadLoadout; the loadout itself is
  // assembled below, once the tool runners (runTool / handleUndo / handleRedo) are defined.
  const { activeGroup, toggleGroup } = useEditorLoadoutTools();
  const { publishEditor } = useDeckHost();

  // Keep onChange and onLeave in refs so they're always current without re-running the effect.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  const onLeaveRef = useRef(onLeave);
  useLayoutEffect(() => { onLeaveRef.current = onLeave; });

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUndo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    undo(view.state, (tr) => view.dispatch(tr));
    view.focus();
  }, []);

  const handleRedo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    redo(view.state, (tr) => view.dispatch(tr));
    view.focus();
  }, []);

  // Run a registry tool's command against the live view, then refocus (the button used
  // mouseDown+preventDefault to preserve the selection). The shared commands.ts layer means a toolbar
  // tap, a keymap shortcut, and a markdown input rule that mean the same thing run the same command.
  const runTool = useCallback((tool: ToolDescriptor) => {
    const view = viewRef.current;
    if (!view) return;
    // Link: open the inline URL+Title form on BOTH targets (mobile = keypad-fed LinkEntryBar in the Deck
    // top slot; desktop = native-input DesktopLinkForm in the control strip). Replaces the old window.prompt
    // path entirely (unreliable in an installed PWA). Clean creation form → inserts the linked title at caret.
    if (tool.id === 'link') {
      // Seed the Title from the highlighted selection (#73) → submitLink already REPLACES the selection
      // range with the linked title (tr.insertText(text, from, to)), so no extra replace logic here. With a
      // selection, start focus on URL (Title's pre-filled); empty selection → start on Title as before.
      const sel = view.state.selection;
      const selected = sel.empty ? '' : view.state.doc.textBetween(sel.from, sel.to, ' ');
      setLinkTitle(selected);
      setLinkUrl('');
      setActiveLinkField(selected ? 'url' : 'title');
      setLinkOpen(true);
      return;
    }
    tool.command(deltoSchema)(view.state, view.dispatch);
    view.focus();
  }, []);

  // #69 §6.1 voice: the Deck's voice loadout (deck-core) wired to deltos's concrete Transcriber (single-
  // flight POST /api/transcribe) + commit-to-note. The mic control lives in the selector; while recording,
  // the VoiceLoadout replaces the keypad. transcriber is stable; commit inserts the final transcript at caret.
  // Two transcriber instances (§6.2 clip-cap): the FINAL full-audio pass sends ?final=1 (25MB server cap);
  // the live-preview CHUNK calls omit it (small per-phrase WAVs, 5MB cap). Separate instances so the final
  // pass's single-flight is never debounced by chunk calls.
  const transcriber = useRef(createDeltosTranscriber({ final: true })).current;
  const chunkTranscriber = useRef(createDeltosTranscriber({ final: false })).current;
  const micSupported = isAudioCaptureSupported();
  const commitTranscript = useCallback((transcript: string) => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch(v.state.tr.insertText(transcript).scrollIntoView());
    v.focus();
  }, []);
  // §6.2 live chunked preview: feed the chunk transcriber so useVoiceMode runs the rolling VAD draft while
  // recording (greyed); the final pass on stop replaces it + commits.
  const voice = useVoiceMode(transcriber, commitTranscript, { chunkTranscriber: chunkTranscriber.transcribe });
  // Destructure so the deckLoadouts memo deps are the specific values (start/stop are stable useCallbacks;
  // state/stream/draft change) rather than the always-new `voice` object.
  const { state: voiceState, stream: voiceStream, draft: voiceDraft, start: voiceStart, stop: voiceStop } = voice;

  // The editor loadout published to the Deck: the collapsible keypad + the persistent base region (group
  // selector + Undo/Redo + show/hide toggle) + the active group's submenu above the keys. The tool UI is
  // host-injected (deltos Deploy-3 registry) into the generic core KeypadLoadout via baseExtra + submenu.
  const deckLoadouts = useMemo<DeckLoadoutRegistry>(
    () => ({
      // §6.1: while recording/transcribing, the VoiceLoadout REPLACES the keypad loadout (waveform top +
      // transcript pane + Stop). Otherwise the keypad loadout, whose selector carries the mic control.
      text: voiceState !== 'idle' ? (
        <VoiceLoadout state={voiceState} stream={voiceStream} transcript={voiceDraft} onStop={() => void voiceStop()} />
      ) : (
        <KeypadLoadout
          actions={deckActionsForKeypad}
          keypadShown={keypadShown}
          locked={locked}
          onToggleKeypad={toggleKeypad}
          onToggleLock={toggleLock}
          baseExtra={
            <EditorGroupSelector
              activeGroup={activeGroup}
              toggleGroup={toggleGroup}
              active={active}
              onUndo={handleUndo}
              onRedo={handleRedo}
              mic={micSupported ? {
                recording: false, // the selector mic only shows when idle (VoiceLoadout takes over otherwise)
                onTap: () => void voiceStart(),       // TAP = start (stop via the VoiceLoadout's Stop)
                onHoldStart: () => void voiceStart(),  // LONG-PRESS = hold-to-talk
                onHoldEnd: () => void voiceStop(),     // release → stop
              } : undefined}
            />
          }
          topSlot={
            // ONE occupant of the top slot, by precedence: link URL entry (an active modal interaction) >
            // spell suggestion bar > open formatting submenu. §5.1.
            linkOpen ? (
              <LinkEntryBar
                title={linkTitle}
                url={linkUrl}
                activeField={activeLinkField}
                onFocusField={setActiveLinkField}
                onSubmit={submitLink}
                onCancel={cancelLink}
              />
            ) : spellSuggest ? (
              <SpellSuggestionBar
                word={spellSuggest.word}
                suggestions={spellSuggest.suggestions}
                onPick={(w) => handleSpellPick(spellSuggest.from, spellSuggest.to, w)}
                onAddToDictionary={() => handleAddToDictionary(spellSuggest.word)}
              />
            ) : activeGroup ? (
              <EditorGroupSubmenu activeGroup={activeGroup} active={active} run={runTool} />
            ) : null
          }
        />
      ),
    }),
    [deckActionsForKeypad, keypadShown, locked, toggleKeypad, toggleLock, activeGroup, toggleGroup, active, handleUndo, handleRedo, runTool, linkOpen, linkTitle, linkUrl, activeLinkField, submitLink, cancelLink, spellSuggest, handleSpellPick, handleAddToDictionary, voiceState, voiceStream, voiceDraft, voiceStart, voiceStop, micSupported],
  );

  // #69 slice B: the Deck mounts once at the app-shell level (DeckHostProvider) so it persists across
  // routes. The editor PUBLISHES its loadout + live context while a note is open, withdraws (null) on
  // unmount → the host falls back to the navigation loadout.
  useEffect(() => {
    if (!customKb) { publishEditor(null); return; }
    publishEditor({ context: deckContext, loadouts: deckLoadouts });
    return () => publishEditor(null);
  }, [customKb, deckContext, deckLoadouts, publishEditor]);

  // #69 §5: hydrate the spellcheck toggle from deviceState once (sets _loaded → gates engine creation).
  useEffect(() => {
    if (!useSpellcheckStore.getState()._loaded) void useSpellcheckStore.getState().init();
  }, []);


  useEffect(() => {
    if (!containerRef.current) return;

    // Reset active state for the incoming note (fresh history, cursor unset).
    setActive(EMPTY_ACTIVE_STATE);

    const doc = spineToPmDoc(deltoSchema, initialBody, initialTitle);

    const basePlugins: Plugin[] = [
      // Inline-formula FIRST: its Backspace-unwrap keymap must intercept before the base keymap (a chip-edge
      // backspace unwraps; everything else falls through). Its '=' auto + '[...]' bracket input rules are
      // order-independent. Self-contained — does not touch core inputRules.ts.
      ...buildFormulaPlugins(formulaRegistry),
      // Autolink ENTER boundary: linkify a trailing URL/bare-domain on Enter (the space boundary is an
      // inputRules.ts rule). Before the base keymap so it intercepts Enter; returns false when no trailing URL.
      buildAutolinkKeymap(),
      buildKeymapPlugin(deltoSchema),
      // Input rules MUST precede uniqueBlockIdPlugin so its appendTransaction runs AFTER the rule's
      // transaction and mints ids for any nodes the rule created (divider, list wrappers).
      buildInputRulesPlugin(deltoSchema),
      history({ newGroupDelay: HISTORY_GROUP_DELAY_MS }),
      dropCursor(),
      gapCursor(),
      uniqueBlockIdPlugin,
      titlePlaceholderPlugin,
      linkCardPastePlugin(deltoSchema), // #69 E2b: bare-URL paste → link_card
    ];
    basePluginsRef.current = basePlugins; // #69 §5: the spellcheck plugin is added on top via reconfigure
    const state = EditorState.create({ doc, plugins: basePlugins });

    const view = new EditorView(containerRef.current, {
      state,
      // #69 §5: ALWAYS suppress the NATIVE browser spellcheck (spellcheck="false") — deltos spellcheck is
      // one unified app-wide system, so native must never compete (double squiggles on desktop). It stays
      // off even when our toggle is off (ours-or-nothing). Plus #69: when the custom keyboard is on,
      // suppress the native keyboard (inputmode=none, set at view-creation before focus — dynamic toggling
      // is unreliable on Safari, probe #68).
      attributes: {
        spellcheck: 'false',
        ...(customKb ? { inputmode: 'none', autocorrect: 'off', autocapitalize: 'off' } : {}),
      },
      nodeViews: {
        ...buildPluginIslandNodeViews(deltoSchema),
        todo_item: (node, view, getPos) =>
          new TodoItemView(node, view, getPos as () => number | undefined),
        // Inline-formula node → type-dispatched NodeView (editable spec + per-type output widget).
        formula: buildFormulaNodeView(formulaRegistry),
      },
      // Plain text clipboard: markdown-flavoured structure for text/plain flavour.
      clipboardTextSerializer: sliceToPlainText,
      // Strip scripts and on* event handlers from HTML pasted from external sources.
      transformPastedHTML(html: string): string {
        const div = document.createElement('div');
        div.innerHTML = html;
        div.querySelectorAll('script, style, link, meta').forEach((el) => el.remove());
        div.querySelectorAll('*').forEach((el) => {
          const attrs = [...el.attributes];
          for (const attr of attrs) {
            if (attr.name.startsWith('on') || attr.name === 'style') {
              el.removeAttribute(attr.name);
            }
          }
        });
        return div.innerHTML;
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr);
        view.updateState(newState);

        // Recompute the selection-driven active snapshot on EVERY transaction (selection moves are
        // transactions too) so toolbar marks/block + undo/redo availability stay reactive from one place.
        setActive(deriveActiveState(newState, undoDepth(newState) > 0, redoDepth(newState) > 0));
        // #69: the keyboard footprint is a pure function of context — re-derive it from the selection.
        setDeckContext(deriveDeckContext(newState));

        if (!tr.docChanged) return;

        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const title = extractTitleFromDoc(view.state.doc);
          const body = pmDocToSpine(view.state.doc);
          onChangeRef.current(title, body);
        }, SAVE_DEBOUNCE_MS);
      },
      // Flush the pending debounce on blur so the Dexie write starts before the route
      // change (iOS fires blur during the swipe-back gesture, ~300ms before navigation
      // completes — enough lead time for IndexedDB to finish before the list mounts).
      handleDOMEvents: {
        // Links open in a NEW TAB on click (#69 links fix): the editable is always-on, so a plain <a>
        // click just placed the caret. Open a safe-scheme href instead (preventDefault + handled = don't
        // place the caret / navigate the app). Drag-select doesn't fire 'click', so editing a link still
        // works (drag across it → Link toolbar toggles/removes). Works desktop + custom-keyboard mode.
        click: (_view, event) => {
          const a = (event.target as HTMLElement | null)?.closest('a[href]');
          if (!a) return false;
          if (openLinkInNewTab(a.getAttribute('href'))) {
            event.preventDefault();
            return true;
          }
          return false; // unsafe scheme (javascript:/data:/…) → ignore, don't open
        },
        // #69 C-manual auto-show: returning focus to the note re-shows the keypad — UNLESS locked (lock
        // suspends auto). A manual hide stays hidden until the next focus-in or a manual show-tap.
        focus: () => {
          if (!lockedRef.current) setKeypadShown(true);
          return false;
        },
        blur: () => {
          if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            const title = extractTitleFromDoc(view.state.doc);
            const body = pmDocToSpine(view.state.doc);
            onChangeRef.current(title, body);
          }
          return false;
        },
      },
    });

    viewRef.current = view;
    setActive(deriveActiveState(view.state, false, false));
    setDeckContext(deriveDeckContext(view.state));
    onViewInit?.(view);
    if (autoFocus) view.focus();

    return () => {
      // Cleanup flush: covers programmatic unmounts where blur may not have fired.
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const title = extractTitleFromDoc(view.state.doc);
        const body = pmDocToSpine(view.state.doc);
        onChangeRef.current(title, body);
      }
      // Signal the note is being left (after the final save so Dexie has latest content).
      onLeaveRef.current?.();
      view.destroy();
      viewRef.current = null;
      onViewInit?.(null);
    };
  // Recreate the view when the keyboard mode flips (customKb decides inputmode=none at creation).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, customKb]);

  // #69 §5: attach the spellcheck plugin when the toggle is ON. The engine is dynamic-imported from its
  // DIRECT module (not deck/index — that's statically imported here) so Rollup code-splits the ~50k dict
  // into a deferred chunk + the worker. Added/removed via reconfigure on the live view; re-runs when the
  // view is recreated (noteId / customKb) so the new view gets the plugin. Cleanup unloads the engine.
  useEffect(() => {
    const view = viewRef.current;
    // No Worker (jsdom/test, SSR) → skip entirely: no dynamic import, no engine, no squiggles.
    if (!view || !spellOn || typeof Worker === 'undefined') return;
    let cancelled = false;
    void import('../deck/spellcheck/spellEngine.js').then(({ createSpellEngine }) => {
      if (cancelled || view.isDestroyed) return;
      const engine = createSpellEngine();
      spellEngineRef.current = engine;
      engine.setAllowList(dictWordsRef.current); // seed the custom-dictionary allow-list (§5.2)
      view.updateState(view.state.reconfigure({
        plugins: [...basePluginsRef.current, createSpellcheckPlugin(engine, handleSpellTap, handleSpellDismiss, recheckSpellRef)],
      }));
    });
    return () => {
      cancelled = true;
      setSpellSuggest(null);
      if (!view.isDestroyed) view.updateState(view.state.reconfigure({ plugins: basePluginsRef.current }));
      spellEngineRef.current?.dispose();
      spellEngineRef.current = null;
    };
  }, [spellOn, noteId, customKb, handleSpellTap, handleSpellDismiss]);

  // The link form's desktop home is SWITCHABLE (Jim's call): true = the unified bottom context slot (with
  // spell suggestions, mirroring mobile's above-keypad slot); false = a transient row under the toolbar by
  // its trigger button. Shipping unified-bottom; flip this one line if the top-click→bottom-form distance
  // bugs Jim on-device. (Watch-item.)
  const LINK_FORM_AT_BOTTOM = true;
  const linkSlot = {
    open: linkOpen,
    title: linkTitle,
    url: linkUrl,
    onChangeTitle: setLinkTitle,
    onChangeUrl: setLinkUrl,
    onSubmit: submitLink,
    onCancel: cancelLink,
  };

  return (
    <>
      {/* Desktop: the Deck editor loadout AS the toolbar — the converged registry rendered flat, a top-
          anchored sticky strip, no keypad/mic/toggle. Replaces the old flat EditorToolbar. Context tooling
          (spell suggestions + link form) lives in the bottom slot below (unified). */}
      {isDesktop && (
        <EditorControlStrip
          active={active}
          onUndo={handleUndo}
          onRedo={handleRedo}
          runTool={runTool}
          link={LINK_FORM_AT_BOTTOM ? undefined : linkSlot}
        />
      )}
      <div
        ref={containerRef}
        {...keypadSwipe}
        className={`editor__pm${customKb ? ' editor__pm--kb' : ''}${customKb && !keypadShown ? ' editor__pm--kb-collapsed' : ''}`}
      />
      {/* Mobile, custom keyboard ON: the Deck (mounted at the shell via DeckHostProvider) owns the bottom
          slot; the editor publishes its keypad loadout + live context to it (see the publishEditor effect
          above), so it persists across routes and isn't torn down by incidental tap-blurs. #69 slice B. */}
      {/* Mobile, custom keyboard OFF: today's grouped contextual bar + native keyboard (slice D). */}
      {!isDesktop && !customKb && (
        <MobileEditorBar active={active} run={runTool} onUndo={handleUndo} onRedo={handleRedo} />
      )}
      {/* Desktop: the optional bottom-mounted context slot — link form (when adding a link) | spell
          suggestions (when on a misspelling). position:fixed (out of flow) → zero space + no page jump when
          it appears/clears. One slot for all desktop context tooling. */}
      {isDesktop && (
        <DesktopContextSlot
          link={LINK_FORM_AT_BOTTOM ? linkSlot : undefined}
          spell={spellSuggest ? {
            word: spellSuggest.word,
            suggestions: spellSuggest.suggestions,
            onPick: (w) => handleSpellPick(spellSuggest.from, spellSuggest.to, w),
            onAddToDictionary: () => handleAddToDictionary(spellSuggest.word),
          } : null}
        />
      )}
      {/* #69 §5.1: suggestion presentation is platform-adaptive. Custom-keyboard mode → the Deck TOP-SLOT
          bar (deckLoadouts topSlot above). Desktop → the bottom context slot above. Only the mobile
          NATIVE-keyboard case (no Deck, no slot) falls back to the anchored popover. */}
      {spellSuggest && !customKb && !isDesktop && (
        <SpellSuggestionPopover
          x={spellSuggest.x}
          y={spellSuggest.y}
          word={spellSuggest.word}
          suggestions={spellSuggest.suggestions}
          onPick={(w) => handleSpellPick(spellSuggest.from, spellSuggest.to, w)}
          onClose={() => setSpellSuggest(null)}
        />
      )}
    </>
  );
}
