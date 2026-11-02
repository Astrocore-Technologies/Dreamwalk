import type { NextConfig } from 'next';
const candidateDist = process.env.DREAMWALK_WEB_DIST_DIR;
if (process.env.VERCEL === '1' && !process.env.API_URL)
  throw new Error('API_URL is required for a Vercel deployment');
const apiOrigin = new URL(process.env.API_URL || 'http://127.0.0.1:4000');
if (
  !['http:', 'https:'].includes(apiOrigin.protocol) ||
  apiOrigin.username ||
  apiOrigin.password ||
  apiOrigin.search ||
  apiOrigin.hash ||
  apiOrigin.pathname !== '/' ||
  (process.env.VERCEL === '1' && apiOrigin.protocol !== 'https:')
)
  throw new Error('API_URL must be an HTTP(S) origin, HTTPS on Vercel');
if (candidateDist && !/^\.next-[a-z0-9-]{1,40}$/.test(candidateDist))
  throw new Error('Invalid local build directory');
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  distDir: candidateDist || (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
  async rewrites() {
    if (process.env.VERCEL === '1') return []; // Hosted HTTP uses server-only ingress injection.
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${apiOrigin.origin}/api/:path*`,
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};
export default config;
