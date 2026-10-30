---
name: setup
description: 새 React/Next.js/React Native 프로젝트에 cony 하네스를 깐다. CLAUDE.md 뼈대, .claude/CONVENTIONS.md, ESLint/Prettier(@conychoi 공용 config), husky + lint-staged, 권한 허용 목록, .cony/ 작업 공간. 사용자가 "프로젝트 세팅", "하네스 깔아줘", "코니 세팅", "/cony:setup" 등으로 요청할 때 사용.
---

# cony 프로젝트 세팅

에이전트가 앞서나가지 못하게 하는 장치를 먼저 까는 단계다. 원칙을 `CLAUDE.md`에 적고, 컨벤션을 문서로 두고, 커밋 전 검사를 자동화한다.

## 0. 현황 확인

- 패키지 매니저(lockfile), 프레임워크, 이미 있는 lint/format/hook 설정을 확인한다.
- 바꿀 것과 지울 것(예: 스캐폴드에 딸려온 oxlint)을 목록으로 보여주고 사용자 확인을 받은 뒤 진행한다.

## 1. 컨벤션 문서

컨벤션 원본은 my-plugins 저장소의 `code-review-fe` 스킬에 있다. 받아서 프로젝트의 `.claude/CONVENTIONS.md`로 저장한다. 이미 있으면 덮어쓰지 말고 차이를 보여준다.

```bash
curl -fsSL https://raw.githubusercontent.com/hwanyoungChoi/my-plugins/main/plugins/development/skills/code-review-fe/references/CONVENTIONS.md -o .claude/CONVENTIONS.md
```

받지 못하면(오프라인 등) 사용자에게 알리고 이 단계만 건너뛴다. 내용을 지어내서 채우지 않는다.

## 2. CLAUDE.md

아래 뼈대로 만든다. **"제약" 섹션은 비워두고 사용자에게 묻는다.** 아직 정하지 않은 구조나 가정을 규칙처럼 적지 않는다. 지침 파일은 이후 모든 판단의 근거가 되므로 사람이 정한 내용만 들어간다.

````markdown
# {프로젝트 이름}

## 작업 원칙

- 해결책을 설계하기 전에, 이미 자리 잡은 제품들이 같은 문제를 어떻게 푸는지 먼저 살펴본다.
  접근 방식을 처음부터 발명하지 말고 검증된 패턴과 관례를 채택한다.
- 하위 호환을 유지하지 않는다. 호환 레이어·폴백·마이그레이션을 덧붙이는 대신 쓰이지 않는 경로를 삭제한다.
- 현재 요구사항을 완전히 충족하는 가장 단순한 구현을 선택한다. 추측에 근거한 추상화, 설정값, 간접 계층을 만들지 않는다.
- 시스템은 레이어로 키운다. 엔드투엔드로 동작하는 최소 버전에서 시작하고, 이미 동작하는 결과물 위에 기능을 하나씩 얹는다.
  동작하는 코드를 미완성 복잡도와 맞바꾸지 않는다.
- 컴포넌트는 모듈로 분리하고 관심사를 명확히 나눈다.
- 검증되고 유지보수되는 라이브러리가 전체 복잡도를 낮추거나 안정성을 높인다면 그것을 쓴다.
  흔한 기능을 명확한 이유 없이 재구현하지 않는다.
- 직접 구현하거나 패키지를 추가하기 전에 이미 설치된 의존성부터 확인한다.
  문서와 타입을 확인하지 않은 채 "이 라이브러리엔 그 기능이 없다"고 단정하지 않는다.
- 아키텍처 결정은 장기 관점으로 한다. 지금만 넘기고 나중에 교체할 임시방편을 받아들이지 않는다.

## 코드 규칙

공통 FE 규칙(디렉토리 구조 · API 호출 · 네이밍 · 주석)은 아래 문서를 따른다.

@.claude/CONVENTIONS.md

## 제약

(사용자가 정한 프로젝트 고유 제약)

## 검증

작업을 마치기 전 아래를 모두 통과시킨다.

```bash
{pm} lint
{pm} format:check
{pm} test
{pm} build
```
````

`{pm}`은 프로젝트 패키지 매니저로 바꾸고, 없는 스크립트는 4단계에서 추가한다.

## 3. ESLint + Prettier

- `@conychoi/eslint-config`, `@conychoi/prettier-config`를 설치한다. 로컬 버전이 아니라 npm 배포본을 쓴다(저장소를 받은 사람이 설치만으로 같은 결과를 얻도록).
- `package.json`에 `"prettier": "@conychoi/prettier-config"`.
- `eslint.config.mjs`:

```js
import reactConfig from "@conychoi/eslint-config/react";

export default [
  ...reactConfig,
  { ignores: ["dist/**"] },
  // 공용 config 는 프로젝트마다 다른 경로 alias 를 알지 못한다.
  // 알려주지 않으면 @/ 가 외부 패키지로 분류되어 import 순서가 컨벤션과 어긋난다.
  { settings: { "import/internal-regex": "^@/" } },
];
```

Next.js면 `eslint-config-next`를 함께 spread한다. 빌드 산출물 디렉토리(`.next`, `dist` 등)를 ignores에 맞춘다.

## 4. scripts

```json
{
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run --passWithNoTests"
}
```

- 테스트 러너가 없으면 무엇을 쓸지(Vite면 vitest, 그 외 jest 등) 사용자에게 묻는다.
- 새 프로젝트는 테스트 파일이 없어서 그냥 `vitest run`이면 실패한다. `--passWithNoTests`를 붙인다(jest도 같은 옵션이 있다).

## 4-1. 화면 확인 도구 (웹 프로젝트, 추천)

qa가 화면을 확인할 수 있게 Playwright를 깐다. 없으면 리드가 브라우저를 직접 열게 되고, 스크린샷이 리드 대화에 쌓여 토큰을 많이 쓴다. 설치할지 사용자에게 묻는다.

- `{pm} add -D @playwright/test` 뒤 `{pm} exec playwright install chromium`
- `playwright.config.ts`: `testDir: "e2e"`, `testMatch: "**/*.e2e.ts"`(vitest의 `*.test`·`*.spec`과 겹치지 않게), `webServer`로 개발 서버를 띄운다.
- scripts에 `"e2e": "playwright test"`. 느려서 CI와 pre-commit에는 넣지 않는다. 넣을지는 사용자가 정한다.
- `.gitignore`에 `test-results/`, `playwright-report/`

## 5. husky + lint-staged

커밋 전에 lint와 format이 자동으로 돌게 한다. 에이전트 기반 개발에서 리뷰 비용을 줄이는 장치다.

```json
"lint-staged": {
  "*.{ts,tsx}": ["eslint --no-warn-ignored --cache --fix", "prettier --write"],
  "*.{json,md,css,html}": ["prettier --write"]
}
```

`.husky/pre-commit`: `{pm} exec lint-staged`

## 6. CI

`/cony:team`은 CI가 모두 통과한 PR만 자동으로 머지한다. CI가 없으면 머지할 수 없으므로 GitHub Actions 워크플로를 만든다. 이미 있으면 검증 명령이 모두 들어 있는지만 확인한다.

`.github/workflows/ci.yml` (pnpm 기준, 다른 패키지 매니저면 설치 단계를 바꾼다):

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm test
      - run: pnpm build
```

- `.nvmrc`가 없으면 로컬 Node 버전으로 만든다. `pnpm/action-setup`은 `package.json`의 `packageManager` 필드를 읽으므로 없으면 추가한다.
- `gh repo edit --delete-branch-on-merge`로 머지된 작업 브랜치가 자동으로 지워지게 한다.
- 개인 계정의 private 저장소는 무료 플랜에서 브랜치 보호(필수 체크)를 쓸 수 없다. 그래도 cony hook이 `gh pr merge` 직전에 CI 결과를 확인해서 통과하지 않은 PR의 머지를 막는다.

## 7-1. 에이전트 팀 (선택)

`team.json`의 `mode`를 `teams`로 쓰려면 Claude Code의 에이전트 팀 기능이 켜져 있어야 한다. 프로젝트 `.claude/settings.json`에 넣는다(이미 있으면 `env`에 합친다). 사용자 설정(`~/.claude/settings.json`)에 `"subagentPromptCacheTtl": "1h"`를 두면 팀원 요청의 캐시가 5분이 아니라 1시간 유지돼 토큰이 덜 든다. 둘 다 사용자가 확인하고 넣는다.

```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```

이 변수가 켜지면 이름을 붙인 서브에이전트가 전부 팀원으로 뜬다. 끄려면 값을 `"0"`으로 둔다.

## 7. 권한 허용 목록

팀이 자율로 일하는 동안 검증, 커밋, push, PR 명령마다 권한 확인 창이 뜨지 않게, `.claude/settings.json`에 허용 목록을 둔다. 이미 있으면 `permissions.allow`에 합친다. `{pm}`은 패키지 매니저로 바꾼다.

```json
{
  "permissions": {
    "allow": [
      "Bash({pm} lint:*)",
      "Bash({pm} format:*)",
      "Bash({pm} test:*)",
      "Bash({pm} build:*)",
      "Bash({pm} exec:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git switch:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(gh pr:*)",
      "Bash(gh run:*)"
    ]
  }
}
```

## 8. 하네스 켜기

**이 단계는 반드시 마지막에 한다.** `.cony/`가 생기는 순간 지침 파일 보호 hook이 켜져서, 그 뒤로는 Claude가 `CLAUDE.md`와 `.claude/`를 수정할 수 없다. 사용자가 직접 고쳐야 한다.

- `.cony/` 디렉토리를 만들고 `board.md`에 "대기 중" 한 줄을 쓴다.
- 팀 구성을 사용자에게 묻고 `.cony/team.json`에 쓴다. 옵션을 외우지 않아도 되게 팀 스킬의 "처음 시작할 때 묻는다" 표에 있는 프리셋(개인 프로젝트 / 회사 프론트 / 채용 과제 / 직접 고르기)으로 묻는다. 직접 고르기를 택한 경우에만 아래를 하나씩 묻는다.
- 역할별 구성: 역할마다 `build`(에이전트가 만든다) / `review`(사람이 만들고 에이전트는 검토와 넘길 문서만) / `off`(이 프로젝트에 없음) 중 하나다. 예: 백엔드를 사내 팀이 맡으면 `{ "pm": "build", "fe": "build", "be": "review", "qa": "build" }`. 정하기 어려워하면 전원 `build`로 두고, 나중에 언제든 바꿀 수 있다고 알린다.
- `merge`: `auto`(팀이 머지까지) / `pr`(PR까지, 머지는 사람) / `none`(커밋까지, push·PR도 사람).
- 같은 파일의 `decisions`도 묻는다. `team`(팀이 토론으로 확정, 개인 프로젝트)과 `user`(팀은 선택지와 추천까지, 사용자가 확정. 채용 과제나 회사 프로젝트) 중 하나다.
- `.gitignore`에 `.cony/.cache/`와 `.eslintcache`(lint-staged의 `--cache`가 만드는 파일)를 추가한다.
- `.cony/`의 나머지(스펙, 결정 기록, 작업 기록, 보고서)를 커밋에 포함할지 사용자에게 묻는다. 결정 기록이 남으면 나중에 "왜 이렇게 했지"를 추적할 수 있어서 포함을 추천한다.

## 9. 터미널 명령 안내

사용자의 셸 설정에 `cony` 함수가 없으면(`type cony`로 확인) 아래 한 줄을 안내한다. 셸 설정 파일은 사용자가 직접 고치게 하고, 원하면 대신 추가한다.

```bash
cony() { node "$(ls -d ~/.claude/plugins/cache/conychoi-plugins/cony/*/ | sort -V | tail -1)skills/board/cli.mjs" "$@"; }
```

## 10. 마무리

- 검증 명령을 한 번 돌려 통과를 확인한다.
- 커밋 단위를 제안한다: lint/format 설정, husky, CI, CLAUDE.md + CONVENTIONS.md, 권한 설정 + .cony는 각각 다른 커밋. 커밋은 사용자가 요청할 때만 한다.
