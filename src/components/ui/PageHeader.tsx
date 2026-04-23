import React from 'react';

interface PageHeaderProps {
  title: string;
  actions?: React.ReactNode;
}

export default function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <header className="flex items-end justify-between flex-wrap gap-4">
      <h1 className="text-[22px] font-semibold tracking-tight text-white">
        {title}
      </h1>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap">{actions}</div>
      )}
    </header>
  );
}
