import { Menu } from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";

interface AppHeaderProps {
  onMenuClick: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ onMenuClick }) => {
  return (
    <header className="sticky top-0 z-100" style={{
      background: 'rgba(249, 247, 244, 0.94)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderBottom: '2px solid hsl(var(--foreground))'
    }}>
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
        {/* Left: Menu + Title */}
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="p-2 transition-colors duration-150 hover:bg-muted md:hidden"
            aria-label="菜单"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-baseline gap-2">
            <span className="text-xl sm:text-2xl font-serif font-black tracking-tight" style={{ fontFamily: "'Noto Serif SC', serif" }}>
              具身智能大模型<span style={{ color: '#C44D34' }}>新闻</span>
            </span>
          </div>
        </div>

        {/* Right: Language */}
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
};