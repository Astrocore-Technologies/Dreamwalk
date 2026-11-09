'use client';
import { useState, type ImgHTMLAttributes } from 'react';
import { portraitFrameLayout, type PortraitFrame } from '@dreamwalk/contracts';
import styles from './framed-portrait.module.css';

/**
 * A portrait shown through the author's chosen frame. Without a frame it is the original image,
 * untouched, so existing layouts and styles keep working. The parent supplies the square/round box.
 */
export function FramedPortrait({
  frame,
  alt = '',
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string;
  frame?: PortraitFrame | null;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (!props.src) return null;
  if (!frame) return <img alt={alt} {...props} />;
  const layout = size ? portraitFrameLayout(size.w, size.h, frame) : null;
  return (
    <span className={styles.frame}>
      <img
        alt={alt}
        {...props}
        onLoad={(event) => {
          setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight });
          props.onLoad?.(event);
        }}
        style={
          layout
            ? { ...props.style, ...layout }
            : { ...props.style, width: '100%', height: '100%', objectFit: 'cover' }
        }
      />
    </span>
  );
}
