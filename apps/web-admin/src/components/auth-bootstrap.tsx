'use client';

import { useAuthBootstrap } from '@/lib/auth';

/** Kok layout'ta bir kez: refresh cookie'si varsa oturumu geri yukler. */
export function AuthBootstrap() {
  useAuthBootstrap();
  return null;
}
