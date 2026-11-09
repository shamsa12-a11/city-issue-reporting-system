/** Underlined tab bar (status filters). */
export default function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mt-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${value === tab.id ? 'border-royal text-royal' : 'border-transparent text-muted hover:text-ink'}`}
        >
          {tab.label}
          {tab.count != null && <span className="ml-1.5 rounded-full bg-page px-1.5 py-0.5 text-xs text-muted">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
