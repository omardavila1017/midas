import React, { useState, useRef, useEffect, useCallback } from 'react';

/* ─────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────── */

export interface FormulaEditorProps {
  value: string;
  onChange: (value: string) => void;
  variables: { name: string; description: string; currentValue?: number }[];
  previewValue?: number | null;
  error?: string | null;
  placeholder?: string;
}

/* ─────────────────────────────────────────────────
   FormulaEditor Component
   ───────────────────────────────────────────────── */

export default function FormulaEditor({
  value,
  onChange,
  variables,
  previewValue,
  error,
  placeholder = 'Ingresa una fórmula (ej: revenue * 0.1 + costs)',
}: FormulaEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredVars, setFilteredVars] = useState<typeof variables>([]);

  /* ─ Compute autocomplete suggestions ─ */
  useEffect(() => {
    if (!textareaRef.current) return;

    const text = value;
    const pos = cursorPos;

    // Find the word being typed (from last space or operator)
    let wordStart = pos - 1;
    while (wordStart >= 0 && /[a-zA-Z0-9_]/.test(text[wordStart])) {
      wordStart--;
    }
    wordStart++;

    const currentWord = text.slice(wordStart, pos).toLowerCase();

    if (currentWord.length > 0) {
      const filtered = variables.filter(v =>
        v.name.toLowerCase().includes(currentWord)
      );
      setFilteredVars(filtered);
      setShowAutocomplete(filtered.length > 0);
      setSelectedIndex(0);
    } else {
      setShowAutocomplete(false);
      setFilteredVars([]);
    }
  }, [value, cursorPos, variables]);

  /* ─ Handle textarea input ─ */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    setCursorPos(e.target.selectionStart);
  };

  /* ─ Handle cursor position tracking ─ */
  const handleClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPos((e.target as HTMLTextAreaElement).selectionStart);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Arrow navigation in autocomplete
    if (showAutocomplete && filteredVars.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredVars.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredVars.length) % filteredVars.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertVariable(filteredVars[selectedIndex]);
        return;
      }
    }

    // Update cursor position on any key
    setTimeout(() => {
      setCursorPos(textareaRef.current?.selectionStart || 0);
    }, 0);
  };

  /* ─ Insert variable at cursor position ─ */
  const insertVariable = useCallback((variable: (typeof variables)[0]) => {
    if (!textareaRef.current) return;

    const text = value;
    const pos = cursorPos;

    // Find word start
    let wordStart = pos - 1;
    while (wordStart >= 0 && /[a-zA-Z0-9_]/.test(text[wordStart])) {
      wordStart--;
    }
    wordStart++;

    // Replace the partial word with the full variable name
    const newValue = text.slice(0, wordStart) + variable.name + text.slice(pos);
    const newCursorPos = wordStart + variable.name.length;

    onChange(newValue);
    setShowAutocomplete(false);

    // Update cursor position after state update
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = newCursorPos;
        textareaRef.current.selectionEnd = newCursorPos;
        textareaRef.current.focus();
        setCursorPos(newCursorPos);
      }
    }, 0);
  }, [value, cursorPos, onChange]);

  /* ─ Insert variable from chip click ─ */
  const handleChipClick = (variable: (typeof variables)[0]) => {
    if (!textareaRef.current) return;

    // Insert at current cursor or at the end
    const pos = cursorPos || value.length;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const space = before && !/[\s+\-*/()]$/.test(before) ? ' ' : '';
    const afterSpace = after && !/^[\s+\-*/()]/.test(after) ? ' ' : '';

    const newValue = before + space + variable.name + afterSpace + after;
    onChange(newValue);
    setShowAutocomplete(false);

    // Refocus and position cursor after variable
    setTimeout(() => {
      const newPos = pos + space.length + variable.name.length + afterSpace.length;
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = newPos;
        textareaRef.current.selectionEnd = newPos;
        setCursorPos(newPos);
      }
    }, 0);
  };

  return (
    <div className="w-full space-y-3">
      {/* Input wrapper with autocomplete dropdown */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={() => setCursorPos(textareaRef.current?.selectionStart || 0)}
          placeholder={placeholder}
          className="w-full min-h-[100px] p-3 rounded-lg border font-mono text-sm resize-none focus:outline-none focus:ring-2 transition-all"
          style={{
            borderColor: error ? 'var(--danger)' : 'var(--gray-200)',
            backgroundColor: 'var(--surface)',
            color: 'var(--gray-950)',
            boxShadow: error
              ? '0 0 0 2px var(--danger-muted)'
              : undefined,
          }}
        />

        {/* Autocomplete dropdown */}
        {showAutocomplete && filteredVars.length > 0 && (
          <div
            className="absolute top-full left-0 right-0 mt-1 bg-white border border-[var(--gray-200)] rounded-lg shadow-md z-50 overflow-hidden"
            style={{
              boxShadow: 'var(--shadow-md)',
              maxHeight: '200px',
              overflowY: 'auto',
            }}
          >
            {filteredVars.map((variable, idx) => (
              <button
                key={variable.name}
                onClick={() => insertVariable(variable)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--primary-muted)] active:bg-[var(--primary-subtle)]"
                style={{
                  backgroundColor:
                    idx === selectedIndex ? 'var(--primary-muted)' : 'transparent',
                  color: 'var(--gray-950)',
                }}
              >
                <div className="font-mono font-medium">{variable.name}</div>
                <div
                  className="text-xs"
                  style={{ color: 'var(--gray-500)' }}
                >
                  {variable.description}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Variable chips */}
      {variables.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {variables.map(variable => (
            <button
              key={variable.name}
              onClick={() => handleChipClick(variable)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-105 active:scale-95"
              style={{
                backgroundColor: 'var(--primary-muted)',
                color: 'var(--primary)',
                border: '1px solid var(--primary-subtle)',
                cursor: 'pointer',
              }}
              title={variable.description}
            >
              {variable.name}
            </button>
          ))}
        </div>
      )}

      {/* Preview value */}
      {previewValue !== null && previewValue !== undefined && (
        <div
          className="p-3 rounded-lg text-sm font-mono"
          style={{
            backgroundColor: 'var(--primary-subtle)',
            color: 'var(--primary)',
            border: '1px solid var(--primary-muted)',
          }}
        >
          <span className="text-xs opacity-70">Resultado: </span>
          <span className="font-semibold">
            {typeof previewValue === 'number'
              ? previewValue.toLocaleString('es-ES', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : '-'}
          </span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div
          className="p-3 rounded-lg text-sm"
          style={{
            backgroundColor: 'var(--danger-muted)',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
