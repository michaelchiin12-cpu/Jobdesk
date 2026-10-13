export type Repeat = "none" | "daily" | "weekdays";

export interface Task {
  id: string;
  title: string;
  pic: string;
  due_at: string;
  note: string | null;
  repeat: Repeat;
  done: boolean;
  done_at: string | null;
  spawned: boolean;
  created_at: string;
}

export interface Member {
  id: string;
  name: string;
  absent_on: string | null;
  created_at: string;
}

export interface NewTask {
  title: string;
  pic: string;
  due_at: string;
  note: string;
  repeat: Repeat;
}
