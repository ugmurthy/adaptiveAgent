use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitState {
    #[default]
    Idle,
    Confirming,
    Draining,
    Approved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseDecision {
    Prevent,
    ShutdownNow,
    Allow,
}

#[derive(Default)]
pub struct QuitCoordinator {
    state: QuitState,
}

impl QuitCoordinator {
    pub fn state(&self) -> QuitState {
        self.state
    }

    pub fn close_requested(&mut self, occupied_roots: usize) -> CloseDecision {
        match self.state {
            QuitState::Approved => CloseDecision::Allow,
            QuitState::Idle if occupied_roots == 0 => {
                self.state = QuitState::Draining;
                CloseDecision::ShutdownNow
            }
            QuitState::Idle => {
                self.state = QuitState::Confirming;
                CloseDecision::Prevent
            }
            QuitState::Confirming | QuitState::Draining => CloseDecision::Prevent,
        }
    }

    pub fn cancel(&mut self) -> Result<(), &'static str> {
        match self.state {
            QuitState::Confirming => {
                self.state = QuitState::Idle;
                Ok(())
            }
            _ => Err("Quit can only be cancelled while confirmation is open."),
        }
    }

    pub fn drain(&mut self) -> Result<(), &'static str> {
        match self.state {
            QuitState::Confirming => {
                self.state = QuitState::Draining;
                Ok(())
            }
            QuitState::Draining => Ok(()),
            _ => Err("Quit draining requires an open confirmation."),
        }
    }

    pub fn approve(&mut self) -> Result<(), &'static str> {
        if self.state != QuitState::Draining {
            return Err("Quit cannot be approved before draining.");
        }
        self.state = QuitState::Approved;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_cancel_and_duplicate_close_are_guarded() {
        let mut quit = QuitCoordinator::default();
        assert_eq!(quit.close_requested(2), CloseDecision::Prevent);
        assert_eq!(quit.state(), QuitState::Confirming);
        assert_eq!(quit.close_requested(2), CloseDecision::Prevent);
        quit.cancel().unwrap();
        assert_eq!(quit.state(), QuitState::Idle);
        quit.close_requested(1);
        quit.drain().unwrap();
        assert_eq!(quit.close_requested(1), CloseDecision::Prevent);
        quit.drain().unwrap();
        quit.approve().unwrap();
        assert_eq!(quit.close_requested(1), CloseDecision::Allow);
    }

    #[test]
    fn empty_close_drains_until_sidecars_have_stopped() {
        let mut quit = QuitCoordinator::default();
        assert_eq!(quit.close_requested(0), CloseDecision::ShutdownNow);
        assert_eq!(quit.state(), QuitState::Draining);
        assert_eq!(quit.close_requested(0), CloseDecision::Prevent);
    }
}
