<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

### Checker workers

The API schedules checks but does not run them. Each region has its own worker
process, and checks only happen while a worker is running:

```bash
# terminal 1: API (schedules every region in CHECK_REGIONS)
$ npm run start:dev

# terminal 2: worker for the region in CHECK_REGION
$ npm run start:worker:dev
```

Set `CHECK_REGIONS` on the API to the comma-separated fleet and `CHECK_REGION`
on each worker to the region it probes. See `.env.example`.

Each scheduled check is claimed in Redis under
`check-lock:{region}:{monitor}:{scheduledTime}` before probing. A duplicate
delivery of the same slot within a region is skipped, and the claim is released
early only when an attempt fails so BullMQ's retry can run.
`CHECK_LOCK_TTL_SECONDS` (default 300) controls how long a successful claim is
retained.

### Flapping detection

Each verdict is recorded in Redis as an up/down transition for its monitor. More
than `FLAP_MAX_CHANGES` transitions (default 5) inside `FLAP_WINDOW_SECONDS`
(default 1800) marks the monitor as flapping: the escalation sweep and outbox
poller suppress alerts while the incident itself stays open. Once the monitor
stops changing state for a full window, the flag expires and the escalation
chain resumes from where it stopped. `GET /monitors` and `GET /monitors/:id`
expose the computed `flapping` boolean.

### Uptime rollups

Raw checks grow without bound, so graphs read from a pre-aggregated table
instead of scanning history. `check_rollups` stores additive counters per
monitor, region, granularity (`HOUR`/`DAY`) and UTC bucket start: check count,
up count, and the response-time sum of successful checks. Uptime percentage and
average response time are derived on read, so combining regions cannot
accumulate rounding drift.

The API process recomputes the previous two completed hourly buckets at five
minutes past each hour UTC, and the previous two completed days at 00:10 UTC.
A Redis lock per bucket keeps multiple API instances from doing the same work;
the upserts are idempotent, so a lost lock or a Redis outage only costs a
duplicate computation.

`GET /api/v1/monitors/:id/uptime` returns materialized buckets for the
authenticated owner:

```text
?granularity=hour|day   defaults to hour
&from=<ISO 8601>        defaults to 24h ago (hour) or 30d ago (day)
&to=<ISO 8601>          defaults to now
&region=<name>          optional; combined across regions when omitted
```

The range is capped at 1000 buckets. Buckets are aligned to UTC boundaries, and
only buckets that have already been materialized are returned. Average response
time covers successful checks only; uptime counts every check.

Backfill existing history from the CLI (it boots no cron jobs; the npm script
compiles the project first, then runs the compiled CLI):

```bash
# hourly buckets for the last 7 days
$ npm run rollup:backfill -- --granularity hour

# an explicit window
$ npm run rollup:backfill -- --granularity day \
    --from 2026-01-01T00:00:00Z --to 2026-03-01T00:00:00Z
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
