/** Layered vector redraw of the original Tucky artwork, in its original coordinates. */
export function TuckyArtwork() {
  return <g stroke="#382610" strokeWidth="17" strokeLinejoin="round" strokeLinecap="round">
    <defs>
      <radialGradient id="fur" cx="38%" cy="30%" r="80%"><stop stopColor="#db963e"/><stop offset=".65" stopColor="#b86b23"/><stop offset="1" stopColor="#8b4918"/></radialGradient>
      <radialGradient id="cream"><stop stopColor="#fff0d5"/><stop offset="1" stopColor="#f1ca96"/></radialGradient>
      <linearGradient id="bag" x2="1" y2="1"><stop stopColor="#85863a"/><stop offset="1" stopColor="#50531e"/></linearGradient>
      <linearGradient id="stripe" x2="1" y2="1"><stop stopColor="#543010"/><stop offset="1" stopColor="#8b4b18"/></linearGradient>
      <clipPath id="note-slot"><path d="M420 690H740V905H420Z"/></clipPath>
    </defs>
    <g id="body">
      <path d="M410 714Q330 822 356 977Q325 1084 418 1117Q627 1163 847 1116Q947 1077 889 965Q940 831 838 714Z" fill="url(#fur)"/>
      <path d="M465 737Q410 886 443 1038Q457 1107 637 1119Q802 1116 826 1030L795 744Z" fill="url(#cream)" stroke="none"/>
      <path d="M403 1070Q350 1083 373 1125Q427 1160 510 1128Q464 1074 403 1070Z" fill="url(#fur)"/>
      <path d="M843 1070Q896 1083 879 1125Q823 1160 751 1128Q792 1074 843 1070Z" fill="url(#fur)"/>
      <path d="M406 1097Q388 1110 401 1127M447 1101Q430 1116 438 1132M842 1097Q861 1110 848 1127M804 1101Q821 1116 813 1132" fill="none" strokeWidth="9"/>
    </g>
    <g id="ears" fill="url(#fur)">
      <g className="tucky-ear-left">
        <path d="M354 320Q294 244 345 168Q406 91 480 200L463 316Z"/>
        <path d="M376 285Q345 229 379 195Q411 174 441 247Z" fill="url(#cream)" strokeWidth="10"/>
      </g>
      <g className="tucky-ear-right">
        <path d="M792 202Q860 90 923 167Q975 239 918 326L804 307Z"/>
        <path d="M830 247Q854 178 888 195Q922 226 899 287Z" fill="url(#cream)" strokeWidth="10"/>
      </g>
    </g>
    <path id="head" d="M316 451Q344 229 523 180Q635 143 746 183Q915 222 939 452Q1044 485 1030 590Q1020 719 884 736Q804 766 753 746Q627 815 491 746Q409 755 346 733Q221 701 227 586Q225 496 316 451Z" fill="url(#fur)" strokeWidth="23"/>
    <g fill="url(#stripe)" stroke="none">
      <path d="M524 184L587 173Q586 326 604 420Q550 339 524 184Z"/>
      <path d="M677 175L741 190Q715 342 655 420Q679 286 677 175Z"/>
    </g>
    <path d="M401 538Q350 480 389 385Q431 295 493 341Q559 390 574 552Q625 601 678 550Q695 389 761 343Q824 296 864 384Q905 477 865 539Q941 477 984 536Q1048 640 912 703Q834 740 773 723Q633 796 487 722Q399 745 310 683Q222 624 258 549Q296 479 401 538Z" fill="url(#cream)" stroke="none"/>
    <g className="tucky-brows" fill="none" strokeWidth="17"><path d="M400 361Q455 299 507 355"/><path d="M747 355Q804 300 852 360"/></g>
    {[470, 788].map(cx => <g key={cx} className="tucky-eye" stroke="none">
      <ellipse cx={cx} cy="498" rx="72" ry="104" fill="#382610"/>
      <ellipse cx={cx} cy="509" rx="69" ry="94" fill="#fffdfa"/>
      <g clipPath={`url(#eye-${cx})`}><g className="pupil">
        <ellipse cx={cx + 9} cy="532" rx="53" ry="80" fill="#35210c"/>
        <ellipse cx={cx - 1} cy="493" rx="17" ry="21" fill="white"/>
      </g></g>
      <defs><clipPath id={`lid-${cx}`}><ellipse cx={cx} cy="498" rx="73" ry="105"/></clipPath></defs>
      <g clipPath={`url(#lid-${cx})`}>
        <g className="tucky-eyelid">
          <path d={`M${cx-80} 185H${cx+80}V398Q${cx} 416 ${cx-80} 398Z`} fill="#f5d4a5"/>
          <path d={`M${cx-80} 398Q${cx} 416 ${cx+80} 398`} fill="none" stroke="#382610" strokeWidth="9"/>
        </g>
      </g>
      <path className="tucky-closed-lash" d={`M${cx-47} 553Q${cx} 583 ${cx+47} 553`} fill="none" stroke="#382610" strokeWidth="9"/>
    </g>)}
    <g className="tucky-nose">
      <path d="M578 580Q594 555 626 563Q661 557 674 580Q680 611 626 633Q574 615 578 580Z" fill="#382610" strokeWidth="6"/>
      <ellipse cx="615" cy="580" rx="25" ry="9" fill="#705031" stroke="none"/>
    </g>
    <path className="tucky-mouth-stem" d="M626 630V660" fill="none" strokeWidth="12"/>
    <path className="tucky-mouth-rest" d="M548 646Q551 685 590 683Q613 682 626 663Q643 687 667 683Q699 680 704 646" fill="none" strokeWidth="12"/>
    <path className="tucky-mouth-smile" d="M548 646Q577 668 626 657Q676 668 704 646Q690 710 628 711Q567 707 548 646Z" fill="#563016" strokeWidth="9"/>
    <path className="tucky-mouth-smile" d="M599 699Q625 680 654 701" stroke="#dc9778" strokeWidth="12" fill="none"/>
    <path className="tucky-mouth-thought" d="M606 674Q627 680 649 669" fill="none" strokeWidth="11"/>
    <path className="tucky-mouth-concern" d="M586 688Q626 660 666 688" fill="none" strokeWidth="11"/>
    <path d="M782 753L842 751L767 920L710 896Z" fill="url(#bag)" strokeWidth="14"/>
    <path d="M460 784L498 804L548 926L489 939Z" fill="url(#bag)" strokeWidth="14"/>
    <ellipse cx="615" cy="871" rx="149" ry="51" fill="#393c19" stroke="#5b5c24" strokeWidth="20"/>
    <g clipPath="url(#note-slot)" strokeWidth="10">
      <g className="tucky-note">
        <path d="M498 789L581 758L650 924L557 944Z" fill="#fff0d2"/>
        <ellipse cx="540" cy="776" rx="47" ry="23" transform="rotate(-22 540 776)" fill="#fff6e5"/>
        <path d="M514 779Q553 752 563 773Q565 786 535 792M556 831L592 817M568 853L602 840" fill="none" stroke="#c7a573" strokeWidth="7"/>
      </g>
    </g>
    <g className="tucky-pouch">
      <path d="M466 878Q614 951 773 878L772 983Q771 1078 670 1087L551 1080Q468 1075 466 986Z" fill="url(#bag)" strokeWidth="15"/>
      <path d="M487 914L489 991Q490 1056 558 1060L664 1068Q747 1060 750 993V916" fill="none" stroke="#44481c" strokeWidth="6" strokeDasharray="15 13" opacity=".55"/>
      <circle cx="585" cy="999" r="23" fill="#43471d" strokeWidth="9"/><circle cx="580" cy="993" r="9" fill="#959044" stroke="none"/>
    </g>
    <g className="tucky-paw" fill="url(#fur)">
      <path d="M360 750Q286 791 298 863Q312 922 370 921Q430 922 466 822Q505 838 518 815Q548 816 552 782Q574 757 548 731Q487 674 418 728Z" strokeWidth="17"/>
      <path d="M505 750Q540 770 530 791M482 780Q514 794 502 816M433 821Q458 836 478 817" fill="none" strokeWidth="8"/>
    </g>
    <g className="tucky-right-paw">
    <path d="M863 759Q916 810 939 869Q967 963 886 975Q836 987 797 960Q764 945 777 922Q747 905 767 884Q760 854 803 847Q837 837 854 854" fill="url(#fur)" strokeWidth="17"/>
    <path d="M774 899L804 887M782 926L813 911M799 951L826 935" fill="none" strokeWidth="8"/>
    </g>
    <g className="tucky-writing" strokeWidth="10">
      {/* Convex, short forearms: no cut-in elbow or narrow tube-like wrist. */}
      <path d="M384 751C340 755 315 806 331 848C347 887 386 895 426 876L512 835C536 817 526 786 500 779C458 771 425 743 384 751Z" fill="url(#fur)" strokeWidth="17"/>
      <path d="M340 838Q358 879 405 866" fill="none" stroke="#a45c20" strokeWidth="12"/>
      <g transform="rotate(-7 614 850)">
        <path d="M521 738H705V954H521Z" fill="#fff0d2"/>
        <path d="M550 783H646M550 810H633M550 837H658" fill="none" stroke="#bda079" strokeWidth="7"/>
        <path className="tucky-ink" d="M552 867L571 858L584 868L598 857L615 865L633 856" fill="none" stroke="#55623d" strokeWidth="7"/>
      </g>
      <path d="M494 792C469 796 458 822 467 845C476 866 504 871 526 855L544 839Q560 824 548 813Q538 804 521 813Q542 798 531 788Q516 779 494 792Z" fill="url(#fur)"/>
      <path d="M489 827Q505 825 521 817M491 845L514 837" fill="none" strokeWidth="6"/>
      <g className="tucky-writing-paw">
        <path d="M858 752C899 757 925 802 913 844C902 884 869 901 834 886L741 840C716 825 714 797 737 783C775 770 819 743 858 752Z" fill="url(#fur)" strokeWidth="17"/>
        <path d="M900 838Q883 877 850 875" fill="none" stroke="#a45c20" strokeWidth="12"/>
        <path d="M751 776C729 760 698 768 689 791C680 814 692 841 716 846C744 853 771 832 774 810Q777 790 751 776Z" fill="url(#fur)"/>
        <g transform="rotate(34 691 799)">
          <path d="M680 700H704V831L692 862L680 831Z" fill="#6e8050" strokeWidth="7"/>
          <path d="M680 831L692 862L704 831Z" fill="#e4c69c" strokeWidth="6"/>
          <path d="M689 851L692 862L696 851" fill="#382610" strokeWidth="4"/>
          <path d="M685 713H699" stroke="#d5ddb7" strokeWidth="6"/>
        </g>
        <path d="M716 785Q733 777 744 790Q754 804 738 817L720 824Q705 825 702 814Q698 803 716 799" fill="url(#fur)" strokeWidth="8"/>
        <path d="M739 827L727 833" fill="none" strokeWidth="6"/>
      </g>
    </g>
    <g className="tucky-thinking-hands" fill="url(#fur)">
      <path d="M392 751C350 747 322 789 327 832C330 872 360 895 395 883C441 867 477 821 516 784C538 763 531 735 507 727C470 716 433 746 392 751Z"/>
      <path d="M341 833Q351 872 388 871" fill="none" stroke="#a45c20" strokeWidth="11"/>
      <path d="M856 752C899 755 922 795 915 834C908 874 877 893 842 880L713 827C688 816 683 790 700 772C721 752 746 767 771 773C805 780 824 749 856 752Z"/>
      <path d="M703 759C678 746 650 755 639 776C628 797 638 820 661 828C685 837 717 829 733 811Q750 792 733 776Q722 765 703 759Z" strokeWidth="11"/>
      <path d="M650 788Q671 800 695 796M660 812Q680 817 701 810" fill="none" strokeWidth="7"/>
      {/* A rounded fist with one short index resting beneath the chin. */}
      <path d="M478 745C478 715 499 696 526 704Q542 681 560 698L574 677Q586 662 599 673Q611 684 599 700L575 733Q581 757 561 775C542 793 513 787 494 776Q479 765 478 745Z" strokeWidth="12"/>
      <path d="M500 724Q517 716 528 731M500 746Q518 739 532 752M542 720L552 730" fill="none" strokeWidth="7"/>
    </g>
    <g className="tucky-tearing" strokeWidth="10">
      <g className="tucky-tear-left">
        <path d="M387 750C344 751 318 792 327 834C336 875 369 894 409 879L498 841C529 823 524 791 497 779C457 766 426 746 387 750Z" fill="url(#fur)" strokeWidth="17"/>
        <path d="M492 731H626L618 758L635 785L618 812L635 839L618 866L626 908H492Z" fill="#fff0d2"/>
        <path d="M515 767H586M515 789H576M515 844H582" stroke="#bda079" strokeWidth="7"/>
        <path d="M483 786C457 788 445 814 456 838C466 861 493 866 514 851Q532 841 525 829Q520 819 503 824Q530 816 524 801Q516 783 483 786Z" fill="url(#fur)"/>
        <path d="M473 821L493 813M477 843L498 836" fill="none" strokeWidth="6"/>
      </g>
      <g className="tucky-tear-right">
        <path d="M858 750C901 751 927 792 918 834C909 875 876 894 836 879L747 841C716 823 721 791 748 779C788 766 819 746 858 750Z" fill="url(#fur)" strokeWidth="17"/>
        <path d="M626 731H760V908H626L618 866L635 839L618 812L635 785L618 758Z" fill="#fff0d2"/>
        <path d="M665 767H734M677 789H734M672 844H734" stroke="#bda079" strokeWidth="7"/>
        <path d="M769 786C795 788 807 814 796 838C786 861 759 866 738 851Q720 841 727 829Q732 819 749 824Q722 816 728 801Q736 783 769 786Z" fill="url(#fur)"/>
        <path d="M779 821L759 813M775 843L754 836" fill="none" strokeWidth="6"/>
      </g>
    </g>
  </g>;
}
