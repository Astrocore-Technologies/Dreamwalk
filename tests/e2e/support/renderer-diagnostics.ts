import type { ConsoleMessage, Page, TestInfo } from '@playwright/test';

// Diagnostic only: profiling adds overhead. Never changes renderer readiness,
// production code, retries, or the test's existing expectation timeout.
export async function profileOwnerReload(page: Page, info: TestInfo): Promise<() => Promise<void>> {
  const errors: string[] = [];
  const consoleTypes: Record<string, number> = {};
  const webglWarnings: Record<string, number> = {};
  let started = false;
  const bounded = async <T>(phase: string, action: () => Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DIAGNOSTIC_TIMEOUT')), 2000);
        }),
      ]);
    } catch {
      // Do not serialize protocol error messages, URLs, or runtime arguments.
      errors.push(phase);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const observeConsole = (message: ConsoleMessage) => {
    const type = message.type();
    consoleTypes[type] = (consoleTypes[type] || 0) + 1;
    // Classify locally; never retain console text or arguments.
    if (type === 'warning' || type === 'error') {
      const text = message.text();
      const kind = /webgl.*context.*lost|context.*lost.*webgl/i.test(text)
        ? 'webgl-context-lost'
        : /too many active webgl contexts/i.test(text)
          ? 'webgl-context-limit'
          : /webgl|gpu stall/i.test(text)
            ? 'webgl-other'
            : undefined;
      if (kind) webglWarnings[kind] = (webglWarnings[kind] || 0) + 1;
    }
  };
  const pathname = (value: string): string => {
    if (!value) return '';
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) &&
        /^\/_next\/static\/[\w./-]+\.[cm]?js$/.test(url.pathname)
        ? url.pathname
        : '[omitted]';
    } catch {
      // Relative script paths are useful; arbitrary eval/data strings are not.
      return /^\/?[\w./-]+\.[cm]?js$/.test(value) ? value : '[omitted]';
    }
  };
  // Browser-level metadata is projected immediately; never retain the returned
  // commandLine, machine model, driver strings, proxy arguments or profile paths.
  const browser = page.context().browser();
  const browserSession = browser
    ? await bounded('browser-session', () => browser.newBrowserCDPSession())
    : undefined;
  let gpuBackend: unknown;
  let launchFlags: unknown;
  if (browserSession) {
    try {
      const system = await bounded('gpu-info', () => browserSession.send('SystemInfo.getInfo'));
      if (system) {
        const renderer = [
          system.gpu.auxAttributes?.glRenderer,
          system.gpu.auxAttributes?.glVendor,
          ...system.gpu.devices.map((device) => device.deviceString),
        ].join(' ');
        gpuBackend = {
          devices: system.gpu.devices.map((device) => ({
            vendorId: Number.isSafeInteger(device.vendorId) ? device.vendorId : undefined,
            deviceId: Number.isSafeInteger(device.deviceId) ? device.deviceId : undefined,
          })),
          software: /swiftshader/i.test(renderer)
            ? 'swiftshader'
            : /llvmpipe/i.test(renderer)
              ? 'llvmpipe'
              : /softpipe/i.test(renderer)
                ? 'softpipe'
                : 'not-identified',
          angle: /\bANGLE\b/.test(renderer),
          vulkan: /vulkan/i.test(renderer),
          features: Object.fromEntries(
            ['webgl', 'webgl2', 'gpu_compositing'].map((key) => {
              const value = system.gpu.featureStatus?.[key];
              return [
                key,
                [
                  'enabled',
                  'enabled_on',
                  'enabled_force',
                  'disabled_off',
                  'disabled_software',
                  'unavailable_software',
                  'unavailable_off',
                  'unavailable_force',
                  'disabled_off_ok',
                ].includes(value || '')
                  ? value
                  : 'not-identified',
              ];
            }),
          ),
        };
      }
      const command = await bounded('browser-flags', () =>
        browserSession.send('Browser.getBrowserCommandLine'),
      );
      if (command) {
        const args = command.arguments;
        launchFlags = {
          headless: args.some((arg) =>
            ['--headless', '--headless=new', '--headless=old'].includes(arg),
          ),
          unsafeSwiftshaderEnabled: args.includes('--enable-unsafe-swiftshader'),
          gpuDisabled: args.includes('--disable-gpu'),
          softwareRasterizerDisabled: args.includes('--disable-software-rasterizer'),
          useAngle: [
            'default',
            'd3d11',
            'd3d9',
            'gl',
            'gles',
            'vulkan',
            'metal',
            'swiftshader',
            'swiftshader-webgl',
          ].find((value) => args.includes(`--use-angle=${value}`)),
          useGl: ['default', 'angle', 'desktop', 'egl', 'swiftshader', 'disabled'].find((value) =>
            args.includes(`--use-gl=${value}`),
          ),
        };
      }
    } catch {
      errors.push('gpu-metadata-projection');
    } finally {
      await bounded('browser-detach', () => browserSession.detach());
    }
  }
  const session = await bounded('session', () => page.context().newCDPSession(page));
  let before: unknown;
  if (session) {
    const cdp = session;
    await bounded('performance-enable', () => cdp.send('Performance.enable'));
    before = await bounded('metrics-before', () => cdp.send('Performance.getMetrics'));
    await bounded('profiler-enable', () => cdp.send('Profiler.enable'));
    started = (await bounded('profiler-start', () => cdp.send('Profiler.start'))) !== undefined;
  }
  page.on('console', observeConsole);
  return async () => {
    // Cleanup and attachment must never replace the original readiness failure.
    try {
      page.off('console', observeConsole);
      const result =
        session && started
          ? await bounded('profiler-stop', () => session!.send('Profiler.stop'))
          : undefined;
      const after = session
        ? await bounded('metrics-after', () => session!.send('Performance.getMetrics'))
        : undefined;
      const metrics = (value: unknown) => {
        const entries = (value as { metrics?: { name: string; value: number }[] } | undefined)
          ?.metrics;
        return entries?.filter(
          (entry) => /^[A-Za-z]+$/.test(entry.name) && Number.isFinite(entry.value),
        );
      };
      const profile = result?.profile;
      const sanitized = profile && {
        startTime: profile.startTime,
        endTime: profile.endTime,
        samples: profile.samples,
        timeDeltas: profile.timeDeltas,
        nodes: profile.nodes.map((node) => ({
          id: node.id,
          hitCount: node.hitCount,
          children: node.children,
          callFrame: {
            functionName: /^[\w.$ <>:-]{0,160}$/.test(node.callFrame.functionName)
              ? node.callFrame.functionName
              : '[anonymous]',
            url: pathname(node.callFrame.url),
            lineNumber: node.callFrame.lineNumber,
            columnNumber: node.callFrame.columnNumber,
          },
        })),
      };
      if (session) await bounded('detach', () => session!.detach());
      await bounded('attach', () =>
        info.attach('owner-final-reload-renderer-diagnostics', {
          body: Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              scope: 'owner-final-reload-readiness-only',
              profilingOverhead: true,
              browserVersion: page.context().browser()?.version(),
              gpuBackend,
              launchFlags,
              consoleTypes,
              webglWarnings,
              metricsBefore: metrics(before),
              metricsAfter: metrics(after),
              profile: sanitized,
              diagnosticErrors: errors,
            }),
          ),
          contentType: 'application/json',
        }),
      );
    } catch {
      // Best effort only, including browser teardown races.
    }
  };
}
