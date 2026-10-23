export function parseArgs(argv) {
  const args = { _: [] }; // positionals collect here; named --key=value args unchanged
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
    else if (/^--[^=]+$/.test(arg)) args[arg.slice(2)] = true; // bare boolean flag
    else args._.push(arg);
  }
  return args;
}
