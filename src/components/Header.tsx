import React from 'react';
import { Settings, Globe, Network } from 'lucide-react';
import { NetworkInterface } from '../types';
import { Language } from '../i18n/translations';

interface HeaderProps {
  t: Record<string, string>;
  language: Language;
  languageNames: Record<Language, string>;
  interfaces: NetworkInterface[];
  currentInterface: NetworkInterface | null;
  onInterfaceChange: (address: string) => void;
  onLanguageChange: (lang: Language) => void;
  onSettingsClick: () => void;
}

const Header: React.FC<HeaderProps> = ({
  t,
  language,
  languageNames,
  interfaces,
  currentInterface,
  onInterfaceChange,
  onLanguageChange,
  onSettingsClick,
}) => {
  return (
    <header className="h-14 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
          <span className="text-white font-bold text-sm">A67</span>
        </div>
        <h1 className="text-lg font-semibold text-white">{t.appTitle}</h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Network Interface Selector */}
        <div className="flex items-center gap-2">
          <Network size={16} className="text-slate-400" />
          <select
            value={currentInterface?.address || ''}
            onChange={(e) => onInterfaceChange(e.target.value)}
            className="bg-slate-700 text-sm text-white rounded px-2 py-1 border border-slate-600 focus:outline-none focus:border-blue-500"
          >
            {interfaces.length === 0 && (
              <option value="">No interfaces</option>
            )}
            {interfaces.map((iface, index) => (
              <option key={`${iface.name}-${iface.address}-${index}`} value={iface.address}>
                {iface.name} ({iface.address})
              </option>
            ))}
          </select>
        </div>

        {/* Language Selector */}
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-slate-400" />
          <select
            value={language}
            onChange={(e) => onLanguageChange(e.target.value as Language)}
            className="bg-slate-700 text-sm text-white rounded px-2 py-1 border border-slate-600 focus:outline-none focus:border-blue-500"
          >
            {Object.entries(languageNames).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Settings Button */}
        <button
          onClick={onSettingsClick}
          className="p-2 rounded hover:bg-slate-700 transition-colors"
          title={t.settings}
        >
          <Settings size={20} className="text-slate-400 hover:text-white" />
        </button>
      </div>
    </header>
  );
};

export default Header;
