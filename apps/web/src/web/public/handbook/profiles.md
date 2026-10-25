# Profiles and reporting lines

Each expert is a generic AI agent with its own identity and memory. A role template supplies an editable starting point. CTO, COO and specialist titles do not grant tool permissions or make a model more capable.

## Edit an expert

1. In Company → People, choose Edit profile for the expert. You can also open it from the expert's profile menu.
2. Set Role title, Skills and expertise (comma separated), Responsibilities (one per line), and Personality and working style. Describe observable duties and how work should be reported.
3. Choose pronouns, voice and a profile picture if desired. Avatar background offers Automatic, Custom color and Transparent; use Background color for a custom shade. The preview updates immediately; Save profile keeps the choice across browsers and session restarts. Voice is independent of pronouns. Use Play sample to preview an available voice.
4. Set Reports to to the owner or another expert. Save profile, then reopen it to verify the saved fields. If a picture upload fails, check the error and retry the picture separately.

Reporting relationships cannot refer to the expert itself or form a cycle. Company default means the existing implicit reporting relationship is preserved: normally the briefing coordinator, with the coordinator reporting to the owner. Changing a reporting parent does not appoint that person as briefing coordinator or grant recovery authority.

Use **Reports to** on a Company card to choose a manager. It saves immediately and redraws the tree. Example: coordinator reports to you; project leads to the coordinator; specialists to their lead. This grants no tool permissions.

## Identity and authority

Profile changes update the role context; they do not replace the expert's memory. Use [Runtime settings](/handbook/models) for plan, harness, model or effort changes.

Company permission checkboxes save immediately with confirmation. Edit profile uses Save profile. Follow [Permissions and preferences](/handbook/permissions) to verify grants rather than relying on a title or checkbox that has not saved.

Keep personal profiles and memories in instance storage. Shared project handoffs should contain verified findings, source locations, checks, blockers and the next action, without private conversation history.

## Enter and leave the office

Switch **In office** off to stop an expert and keep them off. Confirm **Enter office** to resume their laptop and agent on the current plan. Identity, conversation, files and packages persist. Starts queue; failures show a reason. Use **Restart session** to retry. Automatic recovery never returns experts who left.

## Human logins and presence

Open **People** in the Office sidebar to add a human login. Choose **Owner** for full administration of this shared office, or **Limited** for text chat in selected ordinary channels. Limited logins cannot open private DMs, terminals, workspace files, credentials, global event streams or agent controls. Channel access is checked again on every request. Limited human messages are distinct from verified owner instructions. Additional accounts keep sign-in enforced. The existing separate-workspace multi-user mode is a different feature.

Share the generated one-time password privately. It expires in 30 minutes and must be replaced at first sign-in. Each person can set up their own two-step sign-in under **Password and sign-in**. Never put passwords in chat.

Use **Edit access** to change roles/channels or disable an account. Access changes and password resets end that person’s sessions immediately. The original owner account remains protected for recovery. Disabling a person retains their messages.

Signed-in humans appear under **People** in channel member lists, with their name, avatar and Owner/Limited label. Presence expires after about a minute without a visible connected browser; multiple browsers share one identity. Humans do not occupy agent laptop seats. Additional owners edit their own name/avatar on the People page; the original owner uses their chat profile. Human read cursors are independent.
