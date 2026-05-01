# Heartbeat Checklist

tasks:

- name: slack-mention-check
  interval: 30m
  prompt: >
    Check Slack mentions: Run 'agent-messenger slack message search '@ino' --limit 20'.
    
    For each new actionable mention:
    1. Extract task details (what, who, deadline, priority)
    2. Check if it's a follow-up to existing task (thread_ts, quoted text)
    3. If new task: Use TaskFlow to create it
       - Run: taskflow add "[Slack] task description" --project "slack-mentions" --priority P0/P1/P2/P3
       - Include source link (Slack permalink)
       - Set deadline if mentioned
    4. If follow-up: Update existing task status or add note
    5. Post new tasks to today's tasks forum thread
    
    If urgent (P0), notify immediately.
    If no new actionable mentions, reply HEARTBEAT_OK.

- name: taskflow-sync
  interval: 1h
  prompt: >
    Sync TaskFlow tasks with today's forum post.
    
    Run: taskflow list --status incomplete
    
    For each incomplete task:
    1. Check if already in today's forum post
    2. If not: Add to post with proper formatting
    3. If status changed: Update in forum post
    
    Also check for:
    - Tasks due today (notify if not started)
    - Tasks overdue (escalate priority)
    - Tasks completed since last sync (mark as done)
    
    If no changes, reply HEARTBEAT_OK.

- name: notion-sync
  interval: 2h
  prompt: >
    Sync with Notion: Query incomplete tasks from Notion database.
    
    For each Notion task:
    1. Check if already in TaskFlow
    2. If not: Add to TaskFlow with Notion link
       - Run: taskflow add "[Notion] task title" --project "notion-sync" --priority P1
    3. If status changed: Update TaskFlow status
    
    Update today's tasks forum post with changes.
    Cross-reference with Slack mentions to avoid duplicates.
    If no changes, reply HEARTBEAT_OK.

- name: check-task-followups
  interval: 1h
  prompt: >
    Check today's tasks forum thread for user responses.
    
    Look for:
    1. Task status updates ("done", "completed", "finished")
    2. New subtasks or questions
    3. Priority changes or blockers
    
    Actions:
    - If task marked done: Update TaskFlow status
      - Run: taskflow status "task-id" --status done
    - If new info: Update task description or add note
    - If questions: Provide helpful response
    
    Post follow-up summary to thread.
    If no activity, reply HEARTBEAT_OK.

- name: evening-review
  interval: 12h
  prompt: >
    Evening review (around 21:00 KST only).
    
    Generate daily summary using TaskFlow:
    1. Run: taskflow list --status done --today
       - List completed tasks today
    2. Run: taskflow list --status incomplete
       - List remaining tasks
    3. Run: taskflow list --overdue
       - List overdue tasks (escalate if any)
    
    Post summary to today's tasks forum thread:
    - Completed: X tasks
    - Remaining: Y tasks (P0: a, P1: b, P2: c)
    - Overdue: Z tasks (if any)
    - Tomorrow's focus: Top 3 priorities
    
    Update memory/YYYY-MM-DD.md with daily log.

- name: weekly-archive
  interval: 168h
  prompt: >
    Weekly archive (Sunday evening).
    
    Archive completed tasks:
    1. Run: taskflow list --status done --this-week
    2. Export to: memory/completed/YYYY-MM-DD-archive.md
    3. Keep incomplete tasks active
    
    Generate weekly stats:
    - Total completed
    - By project breakdown
    - Average completion time
    - Common blockers
    
    Post weekly summary to tasks forum.

# Rules
- If no urgent items, reply HEARTBEAT_OK
- Keep notifications under 2 lines unless it's a summary
- Night hours (02:00-09:00): always HEARTBEAT_OK
- Post task updates to the tasks forum channel
- Use Korean for all responses
- Always use TaskFlow CLI for task operations
- Include source links (Slack/Notion) in task descriptions
- Sync forum post with TaskFlow status every hour
