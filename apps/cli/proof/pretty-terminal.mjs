// What the pseudo-terminal a proof opened actually reports. The render's
// detection reads exactly these two values, so a suite that asserts on a
// narrow or a dumb terminal proves it got one before it blames the renderer.
process.stdout.write(`${process.stdout.isTTY === true}:${process.stdout.columns ?? 0}:${process.env.TERM ?? ""}\n`);
