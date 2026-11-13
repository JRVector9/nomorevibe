'use client';
import { useEffect, useRef } from 'react';
import './operations-dialog.css';

export function OperationsDialog({ labelledBy, onClose, children }: {
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      // React can remove the dialog before native close restores focus.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return <dialog ref={ref} className="ops-modal" aria-labelledby={labelledBy} onCancel={onClose}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="ops-modal-content">{children}</div>
  </dialog>;
}
