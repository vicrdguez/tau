# Keel prose

Everything an agent reads, kept apart from the code that sends it. Each folder answers one question.

| Folder | Question it answers | Delivered |
| --- | --- | --- |
| `roles/` | Who are you? | As a role's standing instructions. |
| `inputs/` | What just happened, and what now? | As the message keel sends at a transition. One file per situation. |
| `documents/` | What does the thing you write look like? | Inside a role or an input, through a slot. |
| `playbooks/` | How is this kind of work done? | Not wired yet. |
| `principles/` | What do we value when choosing? | Indexed for pulls, bound to inputs by role or path, or triggered by an event. |

A `{{name}}` is a slot. Keel fills it with a fact it already knows, so no file asks an agent to work out its own situation. A file with a different situation is a different file.

A playbook is `playbooks/<name>.md`. Files it refers to live in `playbooks/<name>/`.

`principles/` and `playbooks/` began as copies from [pstack](https://github.com/backnotprop/pstack), under the licence in `LICENSE-pstack`. The principles are in keel form. The playbooks keep their imported substance with pstack and harness operation removed, and are adapted when a lane starts to use them.
