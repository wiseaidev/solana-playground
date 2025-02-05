import { PgCommon } from "../common";
import { PgTerminal } from "../terminal";
import type { Arrayable, Disposable, SyncOrAsync, ValueOf } from "../types";

/** Terminal command implementation */
export type CommandImpl<N extends string, A, S, R> = {
  /** Name of the command that will be used in terminal */
  name: N;
  /** Description that will be seen in the `help` command */
  description: string;
  /* Only process the command if the condition passes */
  preCheck?: Arrayable<() => SyncOrAsync<void>>;
  /** Command arguments */
  args?: A[];
} & (WithSubcommands<S> | WithRun<A, R>);

type WithSubcommands<S> = {
  /** Function to run when the command is called */
  run?: never;
  /** Subcommands */
  subcommands?: S;
};

type WithRun<A, R> = {
  /** Function to run when the command is called */
  run: (input: string, parsed: ParsedInput<A>) => R;
  /** Subcommands */
  subcommands?: never;
};

type ParsedInput<A> = {
  /** Parsed arguments */
  args: A extends Arg<infer N>
    ? {
        [K in N]: string;
      }
    : {};
};

/** Command argument */
export type Arg<N extends string> = {
  /** Name of the argument */
  name: N;
  /** Whether the argument can be omitted */
  optional?: boolean;
};

/** Terminal command inferred implementation */
export type CommandInferredImpl<N extends string, A, S, R> = Omit<
  CommandImpl<N, A, S, R>,
  "subcommands"
> & {
  subcommands?: S extends CommandInferredImpl<
    infer N2,
    infer A2,
    infer S2,
    infer R2
  >
    ? CommandInferredImpl<N2, A2, S2, R2>
    : any[];
};

/** Command type for external usage */
type Command<N extends string, A, S, R> = Pick<
  CommandInferredImpl<N, A, S, R>,
  "name"
> & {
  /** Command processor */
  run(args?: string): Promise<Awaited<R>>;
  /**
   * @param cb callback function to run when the command starts running
   * @returns a dispose function to clear the event
   */
  onDidRunStart(cb: (input: string | null) => void): Disposable;
  /**
   * @param cb callback function to run when the command finishes running
   * @returns a dispose function to clear the event
   */
  onDidRunFinish(cb: (result: Awaited<R>) => void): Disposable;
};

/** Name of all the available commands (only code) */
type CommandCodeName = keyof InternalCommands;

/** Ready to be used commands */
type Commands = {
  [N in keyof InternalCommands]: InternalCommands[N] extends CommandInferredImpl<
    infer N,
    infer A,
    infer S,
    infer R
  >
    ? Command<N, A, S, R>
    : never;
};

/** All commands */
export const PgCommand: Commands = new Proxy(
  {},
  {
    get: (
      target: any,
      cmdCodeName: CommandCodeName
    ): Command<string, unknown, unknown, unknown> => {
      if (!target[cmdCodeName]) {
        const cmdUiName = PgCommandManager.commands[cmdCodeName].name;
        target[cmdCodeName] = {
          name: cmdUiName,
          run: (args = "") => {
            return PgTerminal.executeFromStr(`${cmdUiName} ${args}`, true);
          },
          onDidRunStart: (cb: (input: string | null) => void) => {
            return PgCommon.onDidChange({
              cb,
              eventName: getEventName(cmdCodeName, "start"),
            });
          },
          onDidRunFinish: (cb: (result: unknown) => void) => {
            return PgCommon.onDidChange({
              cb,
              eventName: getEventName(cmdCodeName, "finish"),
            });
          },
        };
      }

      return target[cmdCodeName];
    },
  }
);

/**
 * Terminal command manager.
 *
 * This is intended for internal usage. Running commands should be done with
 * `PgCommand` instead.
 */
export class PgCommandManager {
  /** Internal commands */
  static commands: InternalCommands;

  /**
   * Get the available command names.
   *
   * @returns the command names
   */
  static getNames() {
    return Object.values(PgCommandManager.commands).map((cmd) => cmd.name);
  }

  /**
   * Get the available command completions.
   *
   * @returns the command completions
   */
  static getCompletions() {
    interface Completions {
      [key: string]: Completions;
    }
    const recursivelyGetCompletions = (
      commands: ValueOf<InternalCommands>[],
      completions: Completions = {}
    ) => {
      for (const cmd of commands) {
        completions[cmd.name] = {};
        if (cmd.subcommands) {
          recursivelyGetCompletions(cmd.subcommands, completions[cmd.name]);
        }
      }

      return completions;
    };
    return recursivelyGetCompletions(Object.values(PgCommandManager.commands));
  }

  /**
   * Execute from the given input.
   *
   * All command processing logic happens in this method.
   *
   * @param input full user input starting with the command name
   * @returns the return value of the command
   */
  static async execute(input: string) {
    return await PgTerminal.process(async () => {
      // This guarantees commands only start with the specified command name.
      // `solana-keygen` would not count for inputCmdName === "solana"
      input = input.trim();
      const tokens = input.split(" ");
      const inputCmdName = tokens.at(0);
      if (!inputCmdName) return;

      const cmdDef = PgCommon.entries(PgCommandManager.commands).find(
        ([cmdName]) => cmdName === inputCmdName
      );
      if (!cmdDef) {
        throw new Error(
          `Command \`${PgTerminal.italic(inputCmdName)}\` not found.`
        );
      }
      const cmdName = cmdDef[0];
      let cmd = cmdDef[1];
      let args: string[] = [];

      // Dispatch start event
      PgCommon.createAndDispatchCustomEvent(
        getEventName(cmdName, "start"),
        input
      );

      for (const i in tokens) {
        // Get subcommand
        const token = tokens[i];
        const nextToken = tokens[+i + 1];

        const subCmd = cmd.subcommands?.find((cmd) => cmd.name === token);
        if (subCmd) cmd = subCmd;
        if (nextToken) {
          const isNextTokenSubcommand = cmd.subcommands?.some(
            (cmd) => cmd.name === nextToken
          );
          if (!isNextTokenSubcommand) {
            args = tokens.slice(+i + 1);

            if (!cmd.args) {
              throw new Error(
                `Subcommand doesn't exist: \`${nextToken}\`

Available subcommands: ${cmd.subcommands?.map((cmd) => cmd.name).join(", ")}`
              );
            }
            if (args.length > (cmd.args.length ?? 0)) {
              throw new Error(
                `Provided argument count is higher than expected: ${args.length}`
              );
            }
          }
        }

        // Handle checks
        if (cmd.preCheck) {
          const preChecks = PgCommon.toArray(cmd.preCheck);
          for (const preCheck of preChecks) await preCheck();
        }

        // Early continue if it's not the end of the command
        const isLast = +i === tokens.length - 1;
        if (!isLast && !args.length) continue;

        // Check missing command processor
        if (!cmd.run) {
          PgTerminal.log(`
${cmd.description}

Usage: ${[...tokens.slice(0, +i), cmd.name].join(" ")} <COMMAND>

Commands:

${formatCmdList(cmd.subcommands!)}`);
          break;
        }

        const parsedArgs = {} as Record<string, string>;
        for (const i in cmd.args as Arg<any>[]) {
          const arg = (cmd.args as Arg<any>[])[i];
          const inputArg = args[i];
          if (!inputArg && !arg.optional) {
            throw new Error(`Argument not specified: \`${arg.name}\``);
          }

          parsedArgs[arg.name] = inputArg;
        }

        // Run the command processor
        const result = await cmd.run(input, {
          args: parsedArgs,
        });

        // Dispatch finish event
        PgCommon.createAndDispatchCustomEvent(
          getEventName(cmdName, "finish"),
          result
        );

        return result;
      }
    });
  }
}

/**
 * Format the given list for terminal view.
 *
 * @param list list to format
 * @returns the formatted list
 */
export const formatCmdList = (
  list: Array<{ name: string; description: string }>
) => {
  return list
    .sort((a, b) => {
      // Put non-letter commands to the end
      if (!/^[a-zA-Z-]+$/.test(b.name)) {
        return -1;
      }

      return a.name.localeCompare(b.name);
    })
    .reduce((acc, cmd) => {
      return (
        acc +
        "    " +
        cmd.name +
        new Array(25 - cmd.name.length).fill(" ").reduce((acc, v) => acc + v) +
        cmd.description +
        "\n"
      );
    }, "");
};

/** Get custom event name for the given command. */
const getEventName = (name: string, kind: "start" | "finish") => {
  switch (kind) {
    case "start":
      return "ondidrunstart" + name;
    case "finish":
      return "ondidrunfinish" + name;
  }
};
