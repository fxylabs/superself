# Real-install smoke

The unit tests never load dsh. This is the check that the packed plugin
installs into a dsh profile and its tools answer through dsh's own tool
registry. Run it after every dsh rc bump; the transcript beside this file is
the last run that passed.

`probe.mjs` is a throwaway plugin layered on top of the profile with
`--patch`: it lists the `superself_*` tools the registry holds, calls each
through `ctx.tools.execute`, checks that `/self` is registered, prints, and
exits. It is not installed anywhere and is not part of the published package.

```sh
# 1. a scratch Superself workspace and project (HOME is the self workspace's home)
export HOME=$(mktemp -d) && mkdir -p "$HOME/ws" "$HOME/proj"
git config --global user.name t && git config --global user.email t@example.com
(cd "$HOME/ws" && self init) && (cd "$HOME/proj" && git init -q && git commit -q --allow-empty -m init && self project init --name scratch --no-connect)

# 2. dsh with its own home, the plugin packed and installed into a scratch profile
export DSH_HOME=$(mktemp -d)
(cd apps/dsh-plugin && pnpm build && npm pack --pack-destination /tmp)
npx -y @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile scratch add /tmp/dsh-plugin-superself-0.1.0.tgz

# 3. the probe, from inside the scratch project
printf -- "- insert:\n    - id: superself-probe\n      name: '%s'\n" "$PWD/apps/dsh-plugin/test/smoke/probe.mjs" > "$DSH_HOME/probe.yml"
(cd "$HOME/proj" && npx -y @deepseek-ai/dsh@0.1.1-rc.2 --profile scratch --patch "$DSH_HOME/probe.yml")
```

Expected, in order: the five tool names; `self context` of the scratch project;
the open work list; the bad-id refusal; the empty-text refusal; a recorded
decision; the context again, now carrying that decision; `/self registered`;
`PROBE DONE`. A `tools` load failure or an rc API change shows up here first.
