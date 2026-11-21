# Generative UI for Paseo

**Agents answer with charts, diagrams, maps, plans, and forms rendered inline in the Paseo chat timeline.**

![A Kyoto route on a Map with metrics and reply buttons in Paseo chat](assets/screenshot-map.png)

![A Plan with a comment, a queued choice and the reply pill in Paseo chat](assets/screenshot-chat.png)

![Gen-UI Gallery with 88 components and 176 live examples](assets/screenshot-gallery.png)

![Interactive Playground in Paseo](assets/screenshot-playground.png)

Ported from [ComicBit/bb-plugin-genui](https://github.com/ComicBit/bb-plugin-genui) (Apache-2.0) to Paseo's native timeline transformer, React Native surface, and daemon RPC architecture.

## Install

```bash
paseo plugin add git:anh-chu/paseo-plugin-genui
```

Or from npm:

```bash
paseo plugin add npm:paseo-plugin-genui
```

Requires Paseo 0.14.0 or later.

## What an answer looks like

The agent writes a UI spec as a ```ui block in its reply, after a plain answer sentence. If a block fails, the plugin asks the agent once to fix it. Agents can also pass a spec and a one-sentence answer to the optional `render_ui` tool, which checks the spec first and adds the card only when it renders; the plugin shows the answer as text above the card. Agents used UI far more often with blocks than with the tool, so blocks are the default.

A spec looks like this:

~~~
```ui
$seats = 12
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Go with " + $plan, Send("Go with " + $plan), variant: "primary")
])
```
~~~

Paseo renders a card with a plan switch, a seat slider, and a live total. Moving the slider recomputes the total in place without another model call. Clicking the button sends your choice back to the agent.

## Replies you build

Cards can collect a reply before anything is sent. A button with `Queue(text)` adds its text to your reply instead of sending it. `comments: true` adds a Comment action to each item of a Plan, Steps, List, Table, Findings, Decision or OptionCards, and `editable: true` lets you rewrite an item's text. `Other()` opens a box for anything the agent did not offer. A pill in the composer shows what is queued; the next Send, or Send now in the pill, sends it all as one message.

## Inline apps

An `app` block is a small interactive page, such as a game, a simulation or a tool, that runs inside the reply. The agent writes plain HTML, CSS and JavaScript, and the page runs in a sandbox.

- **Where it runs.** Desktop, web and mobile web always run apps. The iPhone and Android app runs them only in a Paseo build that includes the `HtmlFrame` view. Other builds show the page source instead.
- **What it can't do.** Without your approval an app has no network. It may load scripts, styles, images and fonts from a fixed CDN list (cdnjs, unpkg, jsDelivr `/npm/`, Tailwind, jQuery and Google Fonts) while "Allow CDN libraries" is on. It has no localStorage or cookies, no camera or microphone, no popups and no form submissions. It reads files only through `paseo.load`, which reads like `Load()` and never shows another app's saved data.
- **Asked first.** Sending a message, opening a link or calling AI shows a banner with the exact text, URL or prompt, with Allow, Always for this app and Cancel. The banner times out after 2 minutes. "Always" applies only to that exact HTML, so an edited app asks again.
- **Network approval.** An app that declares hosts with a `paseo-connect` meta tag shows them in a card first. It doesn't start until you choose Allow or Run without network.
- **Saved state.** `paseo.storage` keeps JSON for each app and agent, up to 1 MB. An app with a `paseo-app-id` meta tag keeps its state when its HTML changes. Without one, the state follows the HTML.
- **Settings** (Settings -> Plugins -> Generative UI -> Interactive apps):
  - Allow CDN libraries (on).
  - Allow apps to call AI (on). `paseo.ai` uses Claude Haiku on your Claude subscription through the `claude` CLI on the daemon, and each app still asks first.
  - Reset app approvals, which forgets every network, message, link and AI approval.
  - Run apps automatically on the phone (on). When it is off, an app on iPhone or Android waits for a tap on Run app.

## Components (88 across 10 groups)

| Group | Components |
| --- | --- |
| **Layout** | `Card` · `Row` · `Stack` · `Grid` · `Tabs` · `Details` · `Divider` · `Carousel` |
| **Content** | `Text` · `Callout` · `Draft` · `Metric` · `Badge` · `Icon` · `KeyValue` · `Image` · `File` · `Entity` · `Sources` · `List` |
| **Data** | `Table` · `Chart` (bar, line, area, pie, scatter, radar, funnel, heatmap) · `Sparkline` · `Progress` · `Gauge` · `SegmentedBar` · `Steps` · `Timeline` · `Calendar` · `CalendarHeatmap` · `Tree` · `Code` · `Snippet` · `Diff` · `Diagram` |
| **Media** | `ImageSearch` · `Gallery` · `Map` · `Hotspots` |
| **Inputs** | `Slider` · `Stepper` · `Toggle` · `Choice` · `Radio` · `Select` · `Checklist` · `ListEditor` · `Input` · `TextArea` · `DateInput` · `Rating` · `OptionCards` · `Swatches` · `EditableTable` · `Button` · `Form` · `FollowUps` · `Other` |
| **Widgets** | `Timer` · `Quiz` · `Flashcards` · `Walkthrough` |
| **Project** | `Changes` · `Commits` · `PullRequest` · `Threads` · `Tests` · `Json` |
| **Dev** | `Logs` · `StackTrace` · `Findings` · `Coverage` · `Dependencies` · `Pipeline` · `Benchmark` · `Waterfall` · `Treemap` |
| **Manage** | `Board` · `Roadmap` · `Status` · `Plan` · `Decision` · `Estimate` · `Environments` |
| **Evidence** | `Acceptance` · `Compare` · `Transcript` · `Provenance` |

## Slash commands & surfaces

- `/genui [prompt]` — Teach an existing agent the Generative UI component language.
- `/genui-demo [ComponentName]` — Insert a live interactive Gen-UI block into the current chat (e.g. `/genui-demo Decision` or `/genui-demo Map`).
- `/genui-gallery` — Open the **Gen-UI Gallery** screen (176 examples across all 88 components, plus a live spec Playground).

## Develop

```bash
npm install
npm run typecheck && npm test
paseo plugin install .
paseo plugin reload genui
```

## License

[Apache-2.0](LICENSE). Original DSL, component catalog, and gallery examples by [ComicBit](https://github.com/ComicBit/bb-plugin-genui). Excalifont is under the SIL Open Font License (`assets/fonts/Excalifont-OFL.txt`).
