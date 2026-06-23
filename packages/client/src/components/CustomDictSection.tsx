import { useEffect, useState } from 'react';
import { observeWords, addWord, removeWord, normalizeWord } from '../lib/dictionaryStore.js';

export function CustomDictSection() {
  const [words, setWords] = useState<string[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    const unsub = observeWords(setWords);
    return unsub;
  }, []);

  const handleAdd = async () => {
    const w = normalizeWord(input);
    if (!w) return;
    await addWord(w);
    setInput('');
  };

  return (
    <section className="settings__section" aria-label="Custom dictionary">
      <h2 className="settings__section-title">Custom dictionary</h2>
      {words.length === 0 ? (
        <div className="settings__row">
          <span className="settings__row-label settings__row-label--lede">No custom words yet.</span>
        </div>
      ) : (
        words.map((word) => (
          <div key={word} className="settings__row">
            <span className="settings__row-label">{word}</span>
            <button
              className="settings__row-action"
              onClick={() => { void removeWord(word); }}
              aria-label={`Remove ${word}`}
            >
              Remove
            </button>
          </div>
        ))
      )}
      <div className="settings__row">
        <input
          className="settings__dict-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { void handleAdd(); } }}
          placeholder="Add a word…"
          aria-label="Add word to dictionary"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          className="settings__row-action"
          onClick={() => { void handleAdd(); }}
          disabled={!normalizeWord(input)}
        >
          Add
        </button>
      </div>
    </section>
  );
}
