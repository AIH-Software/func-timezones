# Contributing

Install Node.js 22.14 or later, then run `npm ci` and `npm test`. Run `npm run typecheck` and `npm run build` before submitting a change. The tests and fixed-fixture `npm run demo` run without AWS, Slack, or model credentials.

Include a focused regression test for changes to time parsing, provider fallback, Slack event handling, or queue delivery. Use synthetic examples and keep keys, Slack messages, and generated deployment files out of commits and issues.

To benchmark a model, inject its actual API key from your environment and run `npm run evaluate -- --provider=haiku` or `npm run evaluate -- --provider=luna`. Use `--provider=both` with both keys. Evaluation sends synthetic fixture texts to the selected providers, can incur API costs, and writes results to the ignored `evaluation-results.json` file. Run the [self-host setup](README.md#self-host-on-aws) on a separate stage and test Slack workspace when you need to test delivery end to end.
