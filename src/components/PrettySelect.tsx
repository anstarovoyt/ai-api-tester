import React, { useEffect, useMemo, useRef, useState } from 'react';

interface SelectOption {
  value: string;
  label: string;
  group?: string;
}

interface PrettySelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const PrettySelect: React.FC<PrettySelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  className = ''
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLabel = useMemo(() => {
    return options.find((option) => option.value === value)?.label ?? '';
  }, [options, value]);

  const groupedOptions = useMemo(() => {
    const groups = new Map<string, SelectOption[]>();
    options.forEach((option) => {
      const key = option.group || '';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)?.push(option);
    });
    return Array.from(groups.entries());
  }, [options]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full text-left px-3 py-2 rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-[0_12px_30px_-22px_rgba(15,23,42,0.65)] text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
      >
        <span className="block truncate">
          {selectedLabel || placeholder}
        </span>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-full rounded-xl border border-slate-200 bg-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.75)] overflow-hidden">
          <div className="max-h-64 overflow-auto py-2">
            {groupedOptions.map(([group, groupOptions]) => (
              <div key={group || 'default'}>
                {group && (
                  <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                    {group}
                  </div>
                )}
                {groupOptions.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm transition ${
                      option.value === value
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PrettySelect;
