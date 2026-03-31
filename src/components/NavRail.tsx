import React from 'react';
import { Radio, Server, Clock, FileText, ShieldAlert, GitMerge } from 'lucide-react';
import { ViewId } from '../App';

interface NavRailProps {
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  streamCount: number;
  deviceCount: number;
  ptpCount: number;
  manualCount: number;
  conflictCount: number;
}

interface NavItem {
  id: ViewId;
  icon: React.ReactNode;
  label: string;
  count?: number;
  countColor?: string;
  activeColor: string;
  activeBorder: string;
}

const NavRail: React.FC<NavRailProps> = ({
  activeView,
  onViewChange,
  streamCount,
  deviceCount,
  ptpCount,
  manualCount,
  conflictCount,
}) => {
  const items: NavItem[] = [
    {
      id: 'monitoring',
      icon: <Radio size={20} />,
      label: 'Streams',
      count: streamCount,
      countColor: 'bg-blue-600',
      activeColor: 'text-blue-400',
      activeBorder: 'border-blue-500',
    },
    {
      id: 'devices',
      icon: <Server size={20} />,
      label: 'Devices',
      count: deviceCount,
      countColor: 'bg-slate-600',
      activeColor: 'text-purple-400',
      activeBorder: 'border-purple-500',
    },
    {
      id: 'ptp',
      icon: <Clock size={20} />,
      label: 'PTP',
      count: ptpCount || undefined,
      countColor: 'bg-amber-700',
      activeColor: 'text-amber-400',
      activeBorder: 'border-amber-500',
    },
    {
      id: 'sdp',
      icon: <FileText size={20} />,
      label: 'SDP',
      count: manualCount || undefined,
      countColor: 'bg-slate-600',
      activeColor: 'text-green-400',
      activeBorder: 'border-green-500',
    },
    {
      id: 'routing',
      icon: <GitMerge size={20} />,
      label: 'Routing',
      activeColor: 'text-orange-400',
      activeBorder: 'border-orange-500',
    },
    {
      id: 'permissions',
      icon: <ShieldAlert size={20} />,
      label: 'Permissions',
      count: conflictCount || undefined,
      countColor: 'bg-red-600',
      activeColor: 'text-red-400',
      activeBorder: 'border-red-500',
    },
  ];

  return (
    <nav className="w-14 bg-slate-900 border-r border-slate-700/60 flex flex-col items-center py-2 gap-1 shrink-0">
      {items.map((item) => {
        const isActive = activeView === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            title={item.label}
            className={`
              relative w-10 h-10 flex flex-col items-center justify-center rounded-lg transition-all
              ${isActive
                ? `bg-slate-700/80 ${item.activeColor} border-l-2 ${item.activeBorder}`
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }
            `}
          >
            {item.icon}
            {item.count != null && item.count > 0 && (
              <span className={`absolute -top-0.5 -right-0.5 text-[9px] font-bold ${item.countColor} text-white rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5`}>
                {item.count > 99 ? '99+' : item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
};

export default NavRail;
