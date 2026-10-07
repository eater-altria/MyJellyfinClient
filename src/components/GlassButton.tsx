import { forwardRef, type ButtonHTMLAttributes } from 'react';
import LiquidGlass from './LiquidGlass';

/** A native button whose optical material stays behind its clear label and icon. */
const GlassButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function GlassButton({ children, className = 'glass-button', type = 'button', disabled,
    onPointerMove, onPointerLeave, ...props }, ref) {
    return (
      <button {...props} ref={ref} type={type} disabled={disabled}
        className={`glass-optical-button ${className}`}
        onPointerMove={event => {
          if (!disabled && event.pointerType !== 'touch') {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              event.currentTarget.style.setProperty('--glass-pointer-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
              event.currentTarget.style.setProperty('--glass-pointer-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
            }
          }
          onPointerMove?.(event);
        }}
        onPointerLeave={event => {
          event.currentTarget.style.removeProperty('--glass-pointer-x');
          event.currentTarget.style.removeProperty('--glass-pointer-y');
          onPointerLeave?.(event);
        }}>
        <LiquidGlass as="span" intensity="prominent" className="glass-button-material" aria-hidden="true" />
        <span className="glass-button-content">{children}</span>
      </button>
    );
  },
);

export default GlassButton;
