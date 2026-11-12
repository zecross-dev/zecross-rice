# >>> zecross-rice prompt >>>
__zr_prompt() {
  local code=$?
  local V='\[\e[1;38;2;185;140;255m\]' L='\[\e[38;2;217;194;255m\]' W='\[\e[1;38;2;255;255;255m\]'
  local G='\[\e[38;2;120;110;140m\]' R='\[\e[1;38;2;255;107;157m\]' N='\[\e[0m\]'
  local branch git=''
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) && git=" ${L}⎇ ${branch}"
  local arrow="${V}❯"; [ $code -ne 0 ] && arrow="${R}❯"
  PS1="\[\e]0;\w\a\]${G}╭─ ${V}\u ${G}• ${W}\w${git}${N}\n${G}╰─${arrow}${N} "
}
PROMPT_COMMAND="__zr_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
# <<< zecross-rice prompt <<<
